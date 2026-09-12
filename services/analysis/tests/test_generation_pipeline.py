import uuid
from datetime import UTC, datetime

import boto3
import pytest
from botocore.client import Config
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvconversionstatus,
    Cvfiletype,
    GeneratedDocument,
    Generateddocumentstatus,
    Generateddocumenttype,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory

from analysis import generation_pipeline as generation_pipeline_module
from analysis.generation_pipeline import (
    GenerationPipelineError,
    handle_generation_intake_local,
    run_generation_pipeline,
)
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET, generated_document_key

CV_MARKDOWN = (
    "# Jane Doe\n\n"
    "## Skills\n\n- Python\n- AWS\n- PostgreSQL\n\n"
    "## Experience\n\n"
    "### Backend Engineer — Acme Corp (2021-01 – present)\n\n"
    "Built backend services.\n"
)
JOB_OFFER_STRUCTURED_DATA = {
    "description": "Senior Backend Engineer role focused on Python services.",
    "requirements": ["5+ years Python", "AWS experience"],
}
ANALYSIS_RESULT_JSON = {
    "match_score": 82,
    "matched_skills": [{"skill": "Python", "evidence": "5+ years Python experience"}],
    "missing_skills": [{"skill": "Kubernetes", "importance": "nice_to_have"}],
    "strengths": ["Strong Python background"],
    "weaknesses": ["No Kubernetes experience"],
}


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


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


async def _make_fixture(
    session_factory, user_id, job_offer_id, cv_version_id, analysis_id, document_id, *, doc_type
):
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
                status=Analysisstatus.COMPLETED,
                resultJSON=ANALYSIS_RESULT_JSON,
                matchScore=82,
            )
        )
        session.add(
            GeneratedDocument(
                id=document_id,
                type=doc_type,
                analysisId=analysis_id,
                jobOfferId=job_offer_id,
                cvVersionId=cv_version_id,
                status=Generateddocumentstatus.PENDING,
                updatedAt=now,
            )
        )
        await session.commit()


async def _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id, document_id):
    async with session_factory() as session:
        for model, row_id in (
            (GeneratedDocument, document_id),
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
async def test_run_generation_pipeline_writes_cover_letter_markdown_and_completes():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"
    document_id = f"test-{uuid.uuid4()}"

    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        document_id,
        doc_type=Generateddocumenttype.COVER_LETTER,
    )
    provider = StubLLMProvider(["Dear Hiring Manager, I am excited to apply..."])
    s3 = _s3_client()

    try:
        async with session_factory() as session:
            document = await run_generation_pipeline(
                session, document_id, llm_provider=provider, s3_client=s3
            )
            assert document.status == Generateddocumentstatus.READY
            assert document.markdownContent == "Dear Hiring Manager, I am excited to apply..."
            assert document.errorMessage is None

        expected_key = generated_document_key(user_id, analysis_id, "COVER_LETTER")

        async with session_factory() as session:
            reloaded = await session.get(GeneratedDocument, document_id)
            assert reloaded.status == Generateddocumentstatus.READY
            assert reloaded.s3Key == expected_key

        obj = s3.get_object(Bucket=S3_BUCKET, Key=expected_key)
        assert obj["Body"].read().decode("utf-8") == "Dear Hiring Manager, I am excited to apply..."
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=generated_document_key(user_id, analysis_id, "COVER_LETTER"))
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id, document_id)


@pytest.mark.asyncio
async def test_run_generation_pipeline_fails_with_error_message_on_empty_provider_output():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"
    document_id = f"test-{uuid.uuid4()}"

    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        document_id,
        doc_type=Generateddocumenttype.TAILORED_CV,
    )
    provider = StubLLMProvider(["", "", ""])

    try:
        async with session_factory() as session:
            with pytest.raises(GenerationPipelineError):
                await run_generation_pipeline(session, document_id, llm_provider=provider)

        async with session_factory() as session:
            reloaded = await session.get(GeneratedDocument, document_id)
            assert reloaded.status == Generateddocumentstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.markdownContent is None
            assert reloaded.s3Key is None
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id, document_id)


def test_handle_generation_intake_local_unwraps_records_and_runs_each(monkeypatch):
    """The `generation-intake` local consumer unwraps `event["Records"]` and
    runs `run_generation_pipeline` once per record — a direct analogue of
    `local_pipeline.handle_analysis_intake_local`. Hermetic: the pipeline
    itself is stubbed."""
    seen: list[str] = []

    async def _fake_pipeline(session, document_id, **kwargs):
        seen.append(document_id)

    monkeypatch.setattr(generation_pipeline_module, "run_generation_pipeline", _fake_pipeline)

    handle_generation_intake_local(
        {
            "Records": [
                {"body": '{"generatedDocumentId": "gd-aaa"}'},
                {"body": '{"generatedDocumentId": "gd-bbb"}'},
            ]
        }
    )

    assert seen == ["gd-aaa", "gd-bbb"]


def test_handle_generation_intake_local_swallows_a_pipeline_failure_and_continues(monkeypatch):
    """A pipeline failure is already persisted as FAILED on the row, so the
    consumer must not let it propagate (and redeliver as a poison message) —
    the remaining records are still processed."""
    seen: list[str] = []

    async def _fake_pipeline(session, document_id, **kwargs):
        seen.append(document_id)
        if document_id == "gd-bad":
            raise GenerationPipelineError("missing prerequisite row")

    monkeypatch.setattr(generation_pipeline_module, "run_generation_pipeline", _fake_pipeline)

    handle_generation_intake_local(
        {
            "Records": [
                {"body": '{"generatedDocumentId": "gd-bad"}'},
                {"body": '{"generatedDocumentId": "gd-good"}'},
            ]
        }
    )

    assert seen == ["gd-bad", "gd-good"]
