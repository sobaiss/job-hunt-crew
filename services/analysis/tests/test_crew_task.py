import json
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

from analysis.crew_task import CrewTaskError, run_crew_task
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET, analysis_result_key

JOB_OFFER_STRUCTURED_DATA = {
    "description": "Senior Backend Engineer role focused on Python services.",
    "requirements": ["5+ years Python", "AWS experience"],
    "salary": "€60k-€75k",
    "contractType": "full_time",
    "remotePolicy": "hybrid",
    "seniority": "senior",
}
CV_STRUCTURED_DATA = {
    "skills": ["Python", "AWS", "PostgreSQL"],
    "experience": [],
    "education": [],
}
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


class StubSfnClient:
    def __init__(self):
        self.successes = []
        self.failures = []

    def send_task_success(self, *, taskToken, output):
        self.successes.append((taskToken, output))

    def send_task_failure(self, *, taskToken, error, cause):
        self.failures.append((taskToken, error, cause))


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


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
                structuredData=JOB_OFFER_STRUCTURED_DATA,
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
                structuredData=CV_STRUCTURED_DATA,
                updatedAt=now,
            )
        )
        session.add(
            Analysis(
                id=analysis_id,
                userId=user_id,
                jobOfferId=job_offer_id,
                cvVersionId=cv_version_id,
                status=Analysisstatus.QUEUED,
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


@pytest.mark.asyncio
async def test_run_crew_task_writes_result_to_s3_and_reports_task_success():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT])
    sfn = StubSfnClient()
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)

    try:
        async with session_factory() as session:
            returned_key = await run_crew_task(
                session,
                analysis_id,
                llm_provider=provider,
                s3_client=s3,
                sfn_client=sfn,
                task_token="test-task-token",
            )
        assert returned_key == key

        # The task's literal verification: given a queued Analysis, the S3
        # object appears at the documented analysis-results/{id}.json key.
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        body = json.loads(obj["Body"].read())
        assert body["match_score"] == 82
        assert body["job_offer_id"] == job_offer_id
        assert body["cv_version_id"] == cv_version_id
        assert body["improvement_suggestions"]

        assert sfn.failures == []
        assert len(sfn.successes) == 1
        token, output = sfn.successes[0]
        assert token == "test-task-token"
        assert json.loads(output) == {"analysisId": analysis_id, "s3ResultKey": key}

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            # AWAITING_RESULT, not COMPLETED: PersistResultLambda (M5-T4) is
            # the sole writer of terminal Analysis state, triggered by the S3
            # ObjectCreated event, not this task.
            assert reloaded.status == Analysisstatus.AWAITING_RESULT
            assert reloaded.s3ResultKey == key
            assert reloaded.startedAt is not None
            assert reloaded.resultJSON is None
            assert reloaded.completedAt is None
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_crew_task_fails_and_reports_task_failure_on_malformed_output():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    provider = StubLLMProvider(["not valid json"])
    sfn = StubSfnClient()
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)

    try:
        async with session_factory() as session:
            with pytest.raises(CrewTaskError):
                await run_crew_task(
                    session,
                    analysis_id,
                    llm_provider=provider,
                    s3_client=s3,
                    sfn_client=sfn,
                    task_token="test-task-token",
                )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.s3ResultKey is None

        assert sfn.successes == []
        assert len(sfn.failures) == 1
        token, error, cause = sfn.failures[0]
        assert token == "test-task-token"
        assert cause

        with pytest.raises(s3.exceptions.NoSuchKey):
            s3.get_object(Bucket=S3_BUCKET, Key=key)
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_crew_task_fails_and_reports_task_failure_on_malformed_recommendation_output():
    # Distinct failure path from the comparison-stage malformed-output test
    # above: comparison succeeds (so AnalysisResult's other fields are ready)
    # but the second agent's output never validates. Confirms the Pydantic
    # validation gate applies to the whole pipeline, not just its first step.
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT, "not valid json"])
    sfn = StubSfnClient()
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)

    try:
        async with session_factory() as session:
            with pytest.raises(CrewTaskError):
                await run_crew_task(
                    session,
                    analysis_id,
                    llm_provider=provider,
                    s3_client=s3,
                    sfn_client=sfn,
                    task_token="test-task-token",
                )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.s3ResultKey is None
            assert reloaded.resultJSON is None

        assert sfn.successes == []
        assert len(sfn.failures) == 1

        with pytest.raises(s3.exceptions.NoSuchKey):
            s3.get_object(Bucket=S3_BUCKET, Key=key)
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_crew_task_fails_when_cv_not_parsed_without_calling_llm():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    async with session_factory() as session:
        cv_version = await session.get(CVVersion, cv_version_id)
        cv_version.parseStatus = Cvparsestatus.PENDING
        cv_version.structuredData = None
        await session.commit()

    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT])
    sfn = StubSfnClient()

    try:
        async with session_factory() as session:
            with pytest.raises(CrewTaskError):
                await run_crew_task(
                    session, analysis_id, llm_provider=provider, sfn_client=sfn, task_token="tok"
                )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
        assert provider.calls == 0
        assert len(sfn.failures) == 1
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
