import asyncio
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
    User,
)
from py_db.session import make_engine, make_session_factory

from analysis.crew_task import run_crew_task
from analysis.llm_provider import LLMProvider
from analysis.persist_result_lambda import (
    PersistResultError,
    analysis_id_from_key,
    handle_analysis_result_created,
    persist_analysis_result,
)
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
VALID_ANALYSIS_RESULT = {
    "match_score": 82,
    "matched_skills": [{"skill": "Python", "evidence": "5+ years Python experience"}],
    "missing_skills": [{"skill": "Kubernetes", "importance": "nice_to_have"}],
    "strengths": ["Strong Python background"],
    "weaknesses": ["No Kubernetes experience"],
    "improvement_suggestions": [
        {"area": "Kubernetes", "suggestion": "Get hands-on Kubernetes experience.", "priority": "medium"}
    ],
    "summary": "Strong match on core skills; consider closing the Kubernetes gap.",
    "generated_at": "2026-08-25T00:00:00Z",
    "model_used": "stub-model",
    "job_offer_id": "job-offer-placeholder",
    "cv_version_id": "cv-version-placeholder",
}


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


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


def _s3_event(bucket: str, key: str) -> dict:
    return {"Records": [{"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}]}


async def _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id, *, status):
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
                status=status,
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


def test_analysis_id_from_key_extracts_id_from_documented_key():
    assert analysis_id_from_key("analysis-results/abc-123.json") == "abc-123"


def test_analysis_id_from_key_rejects_unexpected_key():
    with pytest.raises(PersistResultError):
        analysis_id_from_key("raw-scrapes/abc-123.html")


@pytest.mark.asyncio
async def test_analysis_workflow_reaches_completed_purely_from_s3_event_lambda():
    """The task's literal verification: Postgres Analysis reaches COMPLETED
    purely from the S3-event Lambda, with M2-T6's synchronous fallback path
    (comparison_crew.run_analysis) never invoked in this test.
    """
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id, status=Analysisstatus.QUEUED
    )
    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT])
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)

    try:
        # M5-T3's Fargate task step: writes the S3 object, stops at
        # AWAITING_RESULT (never COMPLETED).
        async with session_factory() as session:
            await run_crew_task(session, analysis_id, llm_provider=provider, s3_client=s3)

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.AWAITING_RESULT
            assert reloaded.resultJSON is None

        # M5-T4's step: a synthetic S3 ObjectCreated event drives the sole
        # terminal-state write.
        async with session_factory() as session:
            persisted = await persist_analysis_result(session, analysis_id, s3_client=s3)
            assert persisted.status == Analysisstatus.COMPLETED
            assert persisted.matchScore == 82
            assert persisted.resultJSON["job_offer_id"] == job_offer_id
            assert persisted.resultJSON["improvement_suggestions"]
            assert persisted.completedAt is not None

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.COMPLETED
            assert reloaded.matchScore == 82
            assert reloaded.errorMessage is None
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


def test_handle_analysis_result_created_persists_from_s3_event_shape():
    """`handle_analysis_result_created` is a synchronous Lambda entrypoint
    (it manages its own asyncio event loop via `asyncio.run`, same as
    `intake_handler.handle_analysis_intake`), so — unlike this module's
    other tests — it's exercised from a plain sync test, not
    `pytest.mark.asyncio`, to mirror how a real Lambda invocation calls it.
    Each setup/reload/cleanup step below gets its own fresh engine (rather
    than sharing one across separate `asyncio.run` calls) since an asyncpg
    connection pool is bound to the event loop it was created in, and each
    `asyncio.run` call spins up a brand new loop.
    """
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    async def _setup():
        engine = make_engine()
        try:
            await _make_fixture(
                make_session_factory(engine),
                user_id,
                job_offer_id,
                cv_version_id,
                analysis_id,
                status=Analysisstatus.AWAITING_RESULT,
            )
        finally:
            await engine.dispose()

    async def _reload():
        engine = make_engine()
        try:
            async with make_session_factory(engine)() as session:
                return await session.get(Analysis, analysis_id)
        finally:
            await engine.dispose()

    def _teardown():
        engine = make_engine()
        return _cleanup(engine, make_session_factory(engine), user_id, job_offer_id, cv_version_id, analysis_id)

    asyncio.run(_setup())
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)
    body = dict(VALID_ANALYSIS_RESULT, job_offer_id=job_offer_id, cv_version_id=cv_version_id)
    s3.put_object(Bucket=S3_BUCKET, Key=key, Body=json.dumps(body).encode("utf-8"), ContentType="application/json")

    try:
        handle_analysis_result_created(_s3_event(S3_BUCKET, key))

        reloaded = asyncio.run(_reload())
        assert reloaded.status == Analysisstatus.COMPLETED
        assert reloaded.matchScore == 82
        assert reloaded.resultJSON["summary"] == body["summary"]
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        asyncio.run(_teardown())


@pytest.mark.asyncio
async def test_persist_analysis_result_fails_on_malformed_json_without_partial_write():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id, status=Analysisstatus.AWAITING_RESULT
    )
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)
    s3.put_object(Bucket=S3_BUCKET, Key=key, Body=b"not valid json", ContentType="application/json")

    try:
        async with session_factory() as session:
            with pytest.raises(PersistResultError):
                await persist_analysis_result(session, analysis_id, s3_client=s3)

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.resultJSON is None
            assert reloaded.matchScore is None
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_persist_analysis_result_fails_on_schema_violation_without_partial_write():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id, status=Analysisstatus.AWAITING_RESULT
    )
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)
    # Missing several required Section 8.6 fields (e.g. match_score, summary).
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=json.dumps({"strengths": ["Strong Python background"]}).encode("utf-8"),
        ContentType="application/json",
    )

    try:
        async with session_factory() as session:
            with pytest.raises(PersistResultError):
                await persist_analysis_result(session, analysis_id, s3_client=s3)

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.resultJSON is None
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
