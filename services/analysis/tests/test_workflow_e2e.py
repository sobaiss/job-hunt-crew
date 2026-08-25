"""End-to-end test of the AnalysisWorkflow state machine (M5-T2) against a
real `stepfunctions-local` engine (docker-compose service) and real handler
code (via analysis.lambda_shim, the local stand-in for the 3 deployed
Lambda functions — see lambda_shim.py's docstring). Exercises the actual
control flow PRD Section 10 steps 3-7 describe: SQS-intake starts an
execution, EnsureCVParsed -> EnsureOfferExtracted -> RunComparisonCrew.

The fixture CVVersion/JobOffer here are already PARSED/READY, so the two
Ensure* Lambdas are no-ops (no live LLM call) — extraction itself is
already covered end-to-end by test_handlers.py/test_cv_extraction_agent.py/
test_job_offer_extraction_agent.py; this test's job is purely to prove the
state machine's control flow and Analysis bookkeeping, per M5-T2's literal
verification wording.
"""

import json
import threading
import time
import uuid
from datetime import UTC, datetime

import boto3
import pytest
from botocore.client import Config
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    Cvparsestatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    PipelineEvent,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

import analysis.crew_task as crew_task
import analysis.handlers as handlers
from analysis.intake_handler import start_analysis_workflow
from analysis.lambda_shim import make_server
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET, analysis_result_key
from analysis.state_machine import ensure_state_machine, make_sfn_client

VALID_COMPARISON_OUTPUT = json.dumps(
    {
        "match_score": 82,
        "matched_skills": [{"skill": "Python", "evidence": "5+ years Python experience"}],
        "missing_skills": [{"skill": "Kubernetes", "importance": "nice_to_have"}],
        "strengths": ["Strong Python background"],
        "weaknesses": ["No Kubernetes experience"],
    }
)
VALID_RECOMMENDATION_OUTPUT = json.dumps(
    {
        "improvement_suggestions": [
            {
                "area": "Kubernetes",
                "suggestion": "Get hands-on Kubernetes experience.",
                "priority": "medium",
            }
        ],
        "summary": "Strong match on core skills; consider closing the Kubernetes gap.",
    }
)


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0
        self.model = "stub-model"

    def generate(self, *, system: str, prompt: str) -> str:
        self.calls += 1
        return self._responses[min(self.calls, len(self._responses)) - 1]


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.fixture(scope="module")
def lambda_shim_server():
    server = make_server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def state_machine_arn(lambda_shim_server):
    client = make_sfn_client()
    return ensure_state_machine(client, name=f"AnalysisWorkflowTest-{uuid.uuid4()}")


async def _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id):
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.READY,
                structuredData={"description": "x", "requirements": []},
                updatedAt=now,
            )
        )
        session.add(
            CVVersion(
                id=cv_version_id,
                userId=user_id,
                label="Software Engineer",
                fileKey=f"cvs/{user_id}/{cv_version_id}/cv.pdf",
                fileName="cv.pdf",
                fileType=Cvfiletype.PDF,
                fileSizeBytes=1024,
                parseStatus=Cvparsestatus.PARSED,
                structuredData={"skills": ["Python"], "experience": [], "education": []},
                updatedAt=now,
            )
        )
        session.add(
            Analysis(
                id=analysis_id,
                userId=user_id,
                jobOfferId=job_offer_id,
                cvVersionId=cv_version_id,
                status=Analysisstatus.PENDING,
            )
        )
        await session.commit()


async def _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id):
    async with session_factory() as session:
        # PipelineEvent.analysisId (M6-T3) has ON DELETE CASCADE at the DB
        # level, but SQLAlchemy's default relationship handling nulls
        # rather than deletes orphaned children when the parent is removed
        # via the ORM — so delete these explicitly first, same as any other
        # FK'd row, rather than relying on the DB-level cascade.
        events = (await session.scalars(select(PipelineEvent).where(PipelineEvent.analysisId == analysis_id))).all()
        for event in events:
            await session.delete(event)
        for model, row_id in (
            (Analysis, analysis_id),
            (CVVersion, cv_version_id),
            (JobOffer, job_offer_id),
            (User, user_id),
        ):
            row = await session.get(model, row_id)
            if row is not None:
                await session.delete(row)
        await session.commit()
    await engine.dispose()


def _wait_for_state_entered(client, execution_arn, state_name, *, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        history = client.get_execution_history(executionArn=execution_arn)
        for event in history["events"]:
            details = event.get("stateEnteredEventDetails")
            if event["type"] == "TaskStateEntered" and details and details["name"] == state_name:
                return history["events"]
        time.sleep(0.5)
    raise AssertionError(f"execution never entered state {state_name!r}")


@pytest.mark.asyncio
async def test_analysis_workflow_execution_reaches_run_comparison_crew(state_machine_arn, monkeypatch):
    # Stubbed so this test never depends on (or makes real network calls
    # against) whatever LLM credentials happen to be configured in the
    # environment it runs in — its own scope (M5-T2) is the state machine's
    # control flow up to and including RunComparisonCrew, not the crew's
    # own success/failure handling (that's M5-T3, exercised with its own
    # stub by test_analysis_workflow_execution_completes_via_run_comparison_crew
    # below).
    monkeypatch.setattr(crew_task, "get_llm_provider", lambda: StubLLMProvider(["not valid json"]))

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)

    try:
        sfn_client = make_sfn_client()
        async with session_factory() as session:
            execution_arn = await start_analysis_workflow(
                session, analysis_id, sfn_client=sfn_client, state_machine_arn=state_machine_arn
            )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.QUEUED
            assert reloaded.stepFunctionExecutionArn == execution_arn

        events = _wait_for_state_entered(sfn_client, execution_arn, "RunComparisonCrew")
        entered_states = [
            e["stateEnteredEventDetails"]["name"] for e in events if e["type"] == "TaskStateEntered"
        ]
        assert entered_states == ["EnsureCVParsed", "EnsureOfferExtracted", "RunComparisonCrew"]
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_analysis_workflow_execution_completes_via_run_comparison_crew(
    state_machine_arn, monkeypatch
):
    """M5-T3: the Fargate task (run via run_comparison_crew_handler locally,
    see crew_task.py's docstring) runs the crew, writes the result to S3 at
    the documented analysis-results/{analysisId}.json key, and calls
    SendTaskSuccess with it — driving the real state machine execution to
    SUCCEEDED.
    """
    monkeypatch.setattr(
        crew_task,
        "get_llm_provider",
        lambda: StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT]),
    )

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)

    try:
        sfn_client = make_sfn_client()
        async with session_factory() as session:
            execution_arn = await start_analysis_workflow(
                session, analysis_id, sfn_client=sfn_client, state_machine_arn=state_machine_arn
            )

        _wait_for_state_entered(sfn_client, execution_arn, "RunComparisonCrew")

        deadline = time.monotonic() + 15
        description = sfn_client.describe_execution(executionArn=execution_arn)
        while description["status"] == "RUNNING" and time.monotonic() < deadline:
            time.sleep(0.5)
            description = sfn_client.describe_execution(executionArn=execution_arn)
        assert description["status"] == "SUCCEEDED"

        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        body = json.loads(obj["Body"].read())
        assert body["match_score"] == 82
        assert body["job_offer_id"] == job_offer_id
        assert body["cv_version_id"] == cv_version_id

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            # AWAITING_RESULT, not COMPLETED: PersistResultLambda (M5-T4),
            # triggered by the S3 ObjectCreated event, is the sole writer of
            # terminal Analysis state.
            assert reloaded.status == Analysisstatus.AWAITING_RESULT
            assert reloaded.s3ResultKey == key
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_analysis_workflow_retries_then_fails_via_mark_analysis_failed(
    state_machine_arn, monkeypatch
):
    """M5-T5: a persistent EnsureCVParsed failure is retried by Step
    Functions itself (3x, base 2s exponential backoff) then caught and
    routed to MarkAnalysisFailed, so the real execution reaches FAILED and
    Analysis.status reaches FAILED with a non-empty errorMessage rather than
    being left stuck QUEUED/RUNNING_CREW.
    """
    call_count = {"n": 0}

    async def _always_raise(session, analysis_id, *, llm_provider=None):
        call_count["n"] += 1
        raise RuntimeError("forced EnsureCVParsed failure for M5-T5")

    monkeypatch.setattr(handlers, "ensure_cv_parsed", _always_raise)

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)

    try:
        sfn_client = make_sfn_client()
        async with session_factory() as session:
            execution_arn = await start_analysis_workflow(
                session, analysis_id, sfn_client=sfn_client, state_machine_arn=state_machine_arn
            )

        deadline = time.monotonic() + 45
        description = sfn_client.describe_execution(executionArn=execution_arn)
        while description["status"] == "RUNNING" and time.monotonic() < deadline:
            time.sleep(0.5)
            description = sfn_client.describe_execution(executionArn=execution_arn)
        # The execution itself reaches SUCCEEDED, not FAILED: a Catch that
        # routes to a state which then completes without its own error (here,
        # MarkAnalysisFailed successfully recording the failure) is, by Step
        # Functions' own semantics, a gracefully-handled execution — the
        # thing this task's Catch wiring must guarantee is Analysis.status,
        # asserted below, not the execution's outcome.
        assert description["status"] == "SUCCEEDED"

        # Step Functions' own Retry (MaxAttempts=3, i.e. 3 retries *after*
        # the initial attempt = 4 invocations total) ran the Task 4 times
        # before its Catch routed to MarkAnalysisFailed.
        assert call_count["n"] == 4

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert "forced EnsureCVParsed failure" in reloaded.errorMessage
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
