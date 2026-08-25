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

import threading
import time
import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    Cvparsestatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory

from analysis.intake_handler import start_analysis_workflow
from analysis.lambda_shim import make_server
from analysis.state_machine import ensure_state_machine, make_sfn_client


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
async def test_analysis_workflow_execution_reaches_run_comparison_crew(state_machine_arn):
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

        description = sfn_client.describe_execution(executionArn=execution_arn)
        # RunComparisonCrew is `.waitForTaskToken`; nothing has called
        # SendTaskSuccess/Failure yet (that's M5-T3's Fargate task), so the
        # execution stays RUNNING rather than completing.
        assert description["status"] == "RUNNING"
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
