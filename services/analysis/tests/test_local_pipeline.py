"""Tests for the dev-local in-process AnalysisWorkflow runner
(analysis.local_pipeline). Run against the docker-compose Postgres + MinIO,
same as test_crew_task.py / test_workflow_e2e.py — no Step Functions Local,
no lambda_shim.
"""

import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
from botocore.client import Config
from py_db.models import (
    Analysis,
    Analysisstatus,
    Cvconversionstatus,
    CVVersion,
    Cvfiletype,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    PipelineEvent,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

import analysis.local_pipeline as local_pipeline_module
from analysis.llm_provider import LLMProvider
from analysis.local_pipeline import (
    LocalPipelineError,
    handle_analysis_intake_local,
    run_analysis_pipeline,
)
from analysis.s3_client import S3_BUCKET, analysis_result_key

JOB_OFFER_STRUCTURED_DATA = {
    "description": "Senior Backend Engineer role focused on Python services.",
    "requirements": ["5+ years Python", "AWS experience"],
}
CV_MARKDOWN = "# Jane Doe\n\n## Skills\n\n- Python\n- AWS\n- PostgreSQL\n"
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

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
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


async def _make_fixture(
    session_factory,
    user_id,
    job_offer_id,
    cv_version_id,
    analysis_id,
    *,
    offer_ready: bool = True,
):
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=(
                    Jobofferextractionstatus.READY
                    if offer_ready
                    else Jobofferextractionstatus.SCRAPED
                ),
                structuredData=JOB_OFFER_STRUCTURED_DATA if offer_ready else None,
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
                conversionStatus=Cvconversionstatus.CONVERTED,
                markdownContent=CV_MARKDOWN,
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
        events = (
            await session.scalars(
                select(PipelineEvent).where(PipelineEvent.analysisId == analysis_id)
            )
        ).all()
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
async def test_run_analysis_pipeline_drives_a_pending_analysis_to_completed(monkeypatch):
    import analysis.crew_task as crew_task

    monkeypatch.setattr(
        crew_task,
        "get_llm_provider",
        lambda: StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT]),
    )

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
    )
    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    s3 = _s3_client()
    key = analysis_result_key(analysis_id)

    try:
        async with session_factory() as session:
            result = await run_analysis_pipeline(session, analysis_id)
            assert result.status == Analysisstatus.COMPLETED

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.COMPLETED
            assert reloaded.matchScore == 82
            assert reloaded.resultJSON["job_offer_id"] == job_offer_id
            assert reloaded.errorMessage is None
            assert reloaded.completedAt is not None

        # The crew's S3 result object was written along the way.
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        assert json.loads(obj["Body"].read())["match_score"] == 82
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_analysis_pipeline_lands_failed_with_message_when_a_step_fails():
    # JobOffer is SCRAPED with no rawContentKey, so EnsureOfferExtracted can
    # neither no-op nor scrape — it raises, and the runner's Catch must still
    # leave the Analysis terminal (the state machine's Catch -> MarkAnalysisFailed).
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id, offer_ready=False
    )

    try:
        async with session_factory() as session:
            with pytest.raises(LocalPipelineError):
                await run_analysis_pipeline(session, analysis_id)

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert "rawContentKey" in reloaded.errorMessage
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_analysis_pipeline_raises_when_analysis_missing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            with pytest.raises(LocalPipelineError):
                await run_analysis_pipeline(session, "does-not-exist")
    finally:
        await engine.dispose()


def test_handle_analysis_intake_local_unwraps_records_and_runs_each(monkeypatch):
    """The `analysis-intake` local consumer unwraps `event["Records"]` and runs
    `run_analysis_pipeline` once per record — a direct analogue of
    `handle_cv_conversion`. Hermetic: the pipeline itself is stubbed."""
    seen: list[str] = []

    async def _fake_pipeline(session, analysis_id, **kwargs):
        seen.append(analysis_id)

    monkeypatch.setattr(local_pipeline_module, "run_analysis_pipeline", _fake_pipeline)

    handle_analysis_intake_local(
        {
            "Records": [
                {"body": '{"analysisId": "an-aaa"}'},
                {"body": '{"analysisId": "an-bbb"}'},
            ]
        }
    )

    assert seen == ["an-aaa", "an-bbb"]


def test_handle_analysis_intake_local_swallows_a_pipeline_failure_and_continues(monkeypatch):
    """A pipeline failure is already persisted as FAILED on the row, so the
    consumer must not let it propagate (and redeliver as a poison message) —
    the remaining records are still processed."""
    seen: list[str] = []

    async def _fake_pipeline(session, analysis_id, **kwargs):
        seen.append(analysis_id)
        if analysis_id == "an-bad":
            raise LocalPipelineError("EnsureOfferExtracted failed")

    monkeypatch.setattr(local_pipeline_module, "run_analysis_pipeline", _fake_pipeline)

    handle_analysis_intake_local(
        {
            "Records": [
                {"body": '{"analysisId": "an-bad"}'},
                {"body": '{"analysisId": "an-good"}'},
            ]
        }
    )

    assert seen == ["an-bad", "an-good"]
