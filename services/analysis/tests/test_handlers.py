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

from analysis.handlers import (
    HandlerError,
    ensure_cv_parsed,
    ensure_offer_extracted,
    run_comparison_crew_handler,
)
from analysis.llm_provider import LLMProvider


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    def generate(self, *, system: str, prompt: str) -> str:
        self.calls += 1
        return self._responses[min(self.calls, len(self._responses)) - 1]


async def _make_fixture(
    session_factory,
    user_id,
    job_offer_id,
    cv_version_id,
    analysis_id,
    *,
    cv_parse_status: Cvparsestatus,
    offer_extraction_status: Jobofferextractionstatus,
):
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=offer_extraction_status,
                rawContentKey=f"raw-scrapes/{job_offer_id}.html",
                structuredData=(
                    {"description": "x", "requirements": []}
                    if offer_extraction_status == Jobofferextractionstatus.READY
                    else None
                ),
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
                parseStatus=cv_parse_status,
                structuredData={"skills": ["Python"], "experience": [], "education": []}
                if cv_parse_status == Cvparsestatus.PARSED
                else None,
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


@pytest.mark.asyncio
async def test_ensure_cv_parsed_is_a_noop_when_already_parsed():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        cv_parse_status=Cvparsestatus.PARSED,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )
    provider = StubLLMProvider(["should never be called"])

    try:
        async with session_factory() as session:
            await ensure_cv_parsed(session, analysis_id, llm_provider=provider)
        assert provider.calls == 0
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_ensure_cv_parsed_runs_extraction_when_not_yet_parsed():
    import io

    import boto3
    from botocore.client import Config
    from docx import Document

    from analysis.s3_client import S3_BUCKET

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        cv_parse_status=Cvparsestatus.PENDING,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )

    document = Document()
    document.add_paragraph("Skills: Python, AWS.")
    buf = io.BytesIO()
    document.save(buf)

    s3 = boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )
    async with session_factory() as session:
        cv_version = await session.get(CVVersion, cv_version_id)
        cv_version.fileType = Cvfiletype.DOCX
        cv_version.fileKey = f"cvs/{user_id}/{cv_version_id}/cv.docx"
        cv_version.fileName = "cv.docx"
        await session.commit()
        file_key = cv_version.fileKey
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=buf.getvalue())

    provider = StubLLMProvider(['{"skills": ["Python"], "experience": [], "education": []}'])

    try:
        async with session_factory() as session:
            await ensure_cv_parsed(session, analysis_id, llm_provider=provider)
        assert provider.calls == 1

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.parseStatus == Cvparsestatus.PARSED
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=file_key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_ensure_offer_extracted_is_a_noop_when_already_ready():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        cv_parse_status=Cvparsestatus.PENDING,
        offer_extraction_status=Jobofferextractionstatus.READY,
    )
    provider = StubLLMProvider(["should never be called"])

    try:
        async with session_factory() as session:
            await ensure_offer_extracted(session, analysis_id, llm_provider=provider)
        assert provider.calls == 0
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_ensure_cv_parsed_raises_when_analysis_missing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            with pytest.raises(HandlerError):
                await ensure_cv_parsed(session, "does-not-exist")
    finally:
        await engine.dispose()


def test_run_comparison_crew_handler_returns_analysis_id_and_ack():
    result = run_comparison_crew_handler({"analysisId": "abc", "taskToken": "tok"})
    assert result == {"analysisId": "abc", "received": True}
