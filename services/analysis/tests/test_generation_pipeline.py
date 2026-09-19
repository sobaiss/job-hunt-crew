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


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


async def _make_fixture(
    session_factory,
    user_id,
    job_offer_id,
    cv_version_id,
    analysis_id,
    document_id,
    *,
    doc_type,
    user_name=None,
    user_email=None,
):
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, name=user_name, email=user_email, updatedAt=now))
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


async def _cleanup(
    engine,
    session_factory,
    user_id,
    job_offer_id,
    cv_version_id,
    analysis_id,
    document_id,
):
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


def test_offer_language_falls_through_to_none_not_hardcoded_english():
    # Regression: `fallback` used to default to "en" at the call site, so
    # every offer with no `language` in structuredData (i.e. every offer
    # today — nothing populates it) got its cover letter/tailored CV written
    # in English regardless of the CV/offer's actual language. Against an
    # all-French CV/offer that mismatch made the local dev model degenerate
    # into dumping the raw CV instead of writing prose (analysis
    # 8132ec06-6d99-4624-8d0e-60904dfa4a19). `None` now means "let the
    # writer agents match the CV/offer's own language" instead.
    job_offer = JobOffer(
        id="test-offer",
        sourceUrl="https://example.com/jobs/test-offer",
        sourceSite=Joboffersourcesite.OTHER,
        extractionStatus=Jobofferextractionstatus.READY,
        structuredData=JOB_OFFER_STRUCTURED_DATA,
        updatedAt=_now(),
    )

    assert (
        generation_pipeline_module._offer_language(job_offer, fallback=None) is None
    )


def test_offer_language_prefers_structured_data_language_over_fallback():
    job_offer = JobOffer(
        id="test-offer",
        sourceUrl="https://example.com/jobs/test-offer",
        sourceSite=Joboffersourcesite.OTHER,
        extractionStatus=Jobofferextractionstatus.READY,
        structuredData={**JOB_OFFER_STRUCTURED_DATA, "language": "fr"},
        updatedAt=_now(),
    )

    assert (
        generation_pipeline_module._offer_language(job_offer, fallback="en") == "fr"
    )


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
            assert (
                document.markdownContent
                == "Dear Hiring Manager, I am excited to apply..."
            )
            assert document.errorMessage is None

        expected_key = generated_document_key(user_id, analysis_id, "COVER_LETTER")

        async with session_factory() as session:
            reloaded = await session.get(GeneratedDocument, document_id)
            assert reloaded.status == Generateddocumentstatus.READY
            assert reloaded.s3Key == expected_key

        obj = s3.get_object(Bucket=S3_BUCKET, Key=expected_key)
        assert (
            obj["Body"].read().decode("utf-8")
            == "Dear Hiring Manager, I am excited to apply..."
        )
    finally:
        s3.delete_object(
            Bucket=S3_BUCKET,
            Key=generated_document_key(user_id, analysis_id, "COVER_LETTER"),
        )
        await _cleanup(
            engine,
            session_factory,
            user_id,
            job_offer_id,
            cv_version_id,
            analysis_id,
            document_id,
        )


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
                await run_generation_pipeline(
                    session, document_id, llm_provider=provider
                )

        async with session_factory() as session:
            reloaded = await session.get(GeneratedDocument, document_id)
            assert reloaded.status == Generateddocumentstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.markdownContent is None
            assert reloaded.s3Key is None
    finally:
        await _cleanup(
            engine,
            session_factory,
            user_id,
            job_offer_id,
            cv_version_id,
            analysis_id,
            document_id,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "doc_type",
    [Generateddocumenttype.COVER_LETTER, Generateddocumenttype.TAILORED_CV],
)
async def test_run_generation_pipeline_appends_the_owners_name_and_email(doc_type):
    """The base CV's rendition is redacted (docs/adr/0022), so neither the
    stubbed writer output nor the CV Markdown carries the candidate's contact
    info — the pipeline appends it from the User row, into both the stored
    markdownContent and its S3 mirror."""
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    user_email = f"{user_id}@example.com"
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
        doc_type=doc_type,
        user_name="Ada Lovelace",
        user_email=user_email,
    )
    llm_output = "Experienced backend engineer with a strong Python background."
    provider = StubLLMProvider([llm_output])
    s3 = _s3_client()
    key = generated_document_key(user_id, analysis_id, doc_type.value)

    try:
        async with session_factory() as session:
            await run_generation_pipeline(
                session, document_id, llm_provider=provider, s3_client=s3
            )

        async with session_factory() as session:
            reloaded = await session.get(GeneratedDocument, document_id)
            assert reloaded.markdownContent.startswith(llm_output)
            assert "Ada Lovelace" in reloaded.markdownContent
            assert user_email in reloaded.markdownContent
            stored = reloaded.markdownContent

        assert s3.get_object(Bucket=S3_BUCKET, Key=key)["Body"].read().decode() == stored
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
        await _cleanup(
            engine,
            session_factory,
            user_id,
            job_offer_id,
            cv_version_id,
            analysis_id,
            document_id,
        )


@pytest.mark.asyncio
async def test_run_generation_pipeline_omits_a_null_name_without_a_blank_line():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    user_email = f"{user_id}@example.com"
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
        user_email=user_email,
    )
    provider = StubLLMProvider(["Dear Hiring Manager, I am excited to apply..."])
    s3 = _s3_client()

    try:
        async with session_factory() as session:
            document = await run_generation_pipeline(
                session, document_id, llm_provider=provider, s3_client=s3
            )

        content = document.markdownContent
        assert user_email in content
        assert "None" not in content
        assert "****" not in content
        assert "\n\n\n" not in content
        # The email is the only contact line: nothing but a single blank
        # separator sits between the letter body and it.
        assert content.splitlines()[-1] == user_email
        assert content.splitlines()[-2] == ""
        assert content.splitlines()[-3] != ""
    finally:
        s3.delete_object(
            Bucket=S3_BUCKET,
            Key=generated_document_key(user_id, analysis_id, "COVER_LETTER"),
        )
        await _cleanup(
            engine,
            session_factory,
            user_id,
            job_offer_id,
            cv_version_id,
            analysis_id,
            document_id,
        )


def test_handle_generation_intake_local_unwraps_records_and_runs_each(monkeypatch):
    """The `generation-intake` local consumer unwraps `event["Records"]` and
    runs `run_generation_pipeline` once per record — a direct analogue of
    `local_pipeline.handle_analysis_intake_local`. Hermetic: the pipeline
    itself is stubbed."""
    seen: list[str] = []

    async def _fake_pipeline(session, document_id, **kwargs):
        seen.append(document_id)

    monkeypatch.setattr(
        generation_pipeline_module, "run_generation_pipeline", _fake_pipeline
    )

    handle_generation_intake_local(
        {
            "Records": [
                {"body": '{"generatedDocumentId": "gd-aaa"}'},
                {"body": '{"generatedDocumentId": "gd-bbb"}'},
            ]
        }
    )

    assert seen == ["gd-aaa", "gd-bbb"]


def test_handle_generation_intake_local_swallows_a_pipeline_failure_and_continues(
    monkeypatch,
):
    """A pipeline failure is already persisted as FAILED on the row, so the
    consumer must not let it propagate (and redeliver as a poison message) —
    the remaining records are still processed."""
    seen: list[str] = []

    async def _fake_pipeline(session, document_id, **kwargs):
        seen.append(document_id)
        if document_id == "gd-bad":
            raise GenerationPipelineError("missing prerequisite row")

    monkeypatch.setattr(
        generation_pipeline_module, "run_generation_pipeline", _fake_pipeline
    )

    handle_generation_intake_local(
        {
            "Records": [
                {"body": '{"generatedDocumentId": "gd-bad"}'},
                {"body": '{"generatedDocumentId": "gd-good"}'},
            ]
        }
    )

    assert seen == ["gd-bad", "gd-good"]
