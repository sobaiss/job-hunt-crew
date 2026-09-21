"""Tests for the dev-local in-process AnalysisWorkflow runner
(analysis.local_pipeline). Run against the docker-compose Postgres + MinIO,
same as test_crew_task.py / test_workflow_e2e.py — no Step Functions Local,
no lambda_shim.
"""

import json
import uuid
from datetime import UTC, datetime

from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.client import Config
from llm_settings import LLM_ENV_VARS, seed_setting, wipe_settings
from py_db.models import (
    Analysis,
    Analysisstatus,
    Cvconversionstatus,
    CVVersion,
    Cvfiletype,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    Llmproviderkey,
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
        "matched_skills": [
            {"skill": "Python", "evidence": "5+ years Python experience"}
        ],
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

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema=None,
        temperature: float | None = None,
    ) -> str:
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


async def _cleanup(
    engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id
):
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
async def test_run_analysis_pipeline_drives_a_pending_analysis_to_completed(
    monkeypatch,
):
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
    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id
    )
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
        await _cleanup(
            engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id
        )


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
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_ready=False,
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
        await _cleanup(
            engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id
        )


EXTRACTED_OFFER_OUTPUT = json.dumps(
    {
        "title": "Senior Backend Engineer",
        "company": "Acme Corp",
        "location": "Paris, France",
        "postedAt": "2026-09-01",
        "description": "Senior Backend Engineer role focused on Python services.",
        "requirements": ["5+ years Python", "AWS experience"],
    }
)


def _fake_openai_client(replies: list[str]) -> MagicMock:
    client = MagicMock()
    client.chat.completions.create.side_effect = [
        MagicMock(choices=[MagicMock(message=MagicMock(content=reply))])
        for reply in replies
    ]
    return client


@pytest.mark.asyncio
async def test_run_analysis_pipeline_runs_every_step_on_the_active_llm_provider(
    monkeypatch,
):
    """No injected provider: Conversion, extraction and the comparison run each
    resolve the Active LLM provider (ollama, stored model), and the model
    recorded on the completed Analysis is the stored one."""
    for name in LLM_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")  # the setting overrides this

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
    )
    cv_key = f"cvs/{user_id}/{cv_version_id}/cv.md"
    raw_key = f"raw/{job_offer_id}.html"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=cv_key, Body=CV_MARKDOWN.encode())
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=raw_key,
        Body=b"<html><body><h1>Senior Backend Engineer</h1></body></html>",
    )
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.SCRAPED,
                rawContentKey=raw_key,
                updatedAt=now,
            )
        )
        session.add(
            CVVersion(
                id=cv_version_id,
                userId=user_id,
                label="Software Engineer",
                fileKey=cv_key,
                fileName="cv.md",
                fileType=Cvfiletype.MD,
                fileSizeBytes=len(CV_MARKDOWN),
                conversionStatus=Cvconversionstatus.PENDING,
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
    await wipe_settings(session_factory)
    await seed_setting(
        session_factory, Llmproviderkey.OLLAMA, values={"model": "stored-wiring-model"}
    )
    client = _fake_openai_client(
        [
            CV_MARKDOWN,  # Conversion: redaction/normalisation pass
            EXTRACTED_OFFER_OUTPUT,  # extraction
            VALID_COMPARISON_OUTPUT,
            VALID_RECOMMENDATION_OUTPUT,
        ]
    )

    try:
        with patch("analysis.llm_provider.openai.OpenAI", return_value=client) as ctor:
            async with session_factory() as session:
                result = await run_analysis_pipeline(session, analysis_id)

        assert result.status == Analysisstatus.COMPLETED
        assert result.resultJSON["model_used"] == "stored-wiring-model"
        calls = client.chat.completions.create.call_args_list
        assert len(calls) == 4
        assert {call.kwargs["model"] for call in calls} == {"stored-wiring-model"}
        # One resolution per step: Conversion, extraction, and the comparison run
        # (whose comparison and recommendation share one client).
        assert ctor.call_count == 3
    finally:
        await wipe_settings(session_factory)
        for key in (cv_key, raw_key, analysis_result_key(analysis_id)):
            s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(
            engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id
        )


@pytest.mark.asyncio
async def test_run_analysis_pipeline_fails_naming_provider_and_parameter_when_the_active_provider_has_no_key(
    monkeypatch,
):
    for name in LLM_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "ollama")  # must not be fallen back to

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id
    )
    await wipe_settings(session_factory)
    await seed_setting(session_factory, Llmproviderkey.OPENAI)

    try:
        with patch("analysis.llm_provider.openai.OpenAI") as ctor:
            async with session_factory() as session:
                with pytest.raises(LocalPipelineError):
                    await run_analysis_pipeline(session, analysis_id)
        ctor.assert_not_called()

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert "OpenAI" in reloaded.errorMessage
            assert "apiKey" in reloaded.errorMessage
    finally:
        await wipe_settings(session_factory)
        await _cleanup(
            engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id
        )


@pytest.mark.asyncio
async def test_an_injected_provider_wins_over_the_active_llm_provider(monkeypatch):
    for name in LLM_ENV_VARS:
        monkeypatch.delenv(name, raising=False)

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
        f"test-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory, user_id, job_offer_id, cv_version_id, analysis_id
    )
    await wipe_settings(session_factory)
    await seed_setting(session_factory, Llmproviderkey.OPENAI)  # would fail: no key
    s3 = _s3_client()

    try:
        async with session_factory() as session:
            result = await run_analysis_pipeline(
                session,
                analysis_id,
                llm_provider=StubLLMProvider(
                    [VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT]
                ),
            )
        assert result.status == Analysisstatus.COMPLETED
        assert result.resultJSON["model_used"] == "stub-model"
    finally:
        await wipe_settings(session_factory)
        s3.delete_object(Bucket=S3_BUCKET, Key=analysis_result_key(analysis_id))
        await _cleanup(
            engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id
        )


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


def test_handle_analysis_intake_local_swallows_a_pipeline_failure_and_continues(
    monkeypatch,
):
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
