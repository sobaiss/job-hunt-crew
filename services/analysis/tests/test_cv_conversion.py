"""convert_cv (issue #16): builds a CVVersion's Markdown rendition.

- MD / TXT (slice 1): the uploaded file's UTF-8 text is stored verbatim as
  CVVersion.markdownContent, with no LLM call.
- PDF (slice 2, issue #17): `pypdf` pulls the text, then one LLM normalisation
  pass turns it into clean Markdown; a PDF with almost no extractable text
  fails immediately with a cause message and no LLM call.

Prior art: test_cv_extraction_agent.py (same fixture-bytes + S3 helpers).
"""

import uuid
from datetime import UTC, datetime

import boto3
import pytest
from botocore.client import Config
from py_db.models import CVVersion, Cvconversionstatus, Cvfiletype, PipelineEvent, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from analysis.cv_conversion import MAX_ATTEMPTS, CVConversionError, convert_cv
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET

NORMALISED_MARKDOWN = (
    "# Jane Doe\n\n## Experience\n\n"
    "- **Senior Backend Engineer**, Acme Corp (2019–2024)\n\n"
    "## Skills\n\n- Python\n- AWS\n- PostgreSQL"
)


class ExplodingLLMProvider(LLMProvider):
    """Any call is a test failure — used where convert_cv must not touch an LLM."""

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:  # pragma: no cover
        raise AssertionError("convert_cv must not call the LLM here")


class StubLLMProvider(LLMProvider):
    """Scripted responses; `calls` counts how many times generate() ran."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
        self.calls += 1
        return self._responses[min(self.calls, len(self._responses)) - 1]


def _build_fixture_pdf_bytes(text: str) -> bytes:
    """Hand-crafted minimal single-page PDF with a real, pypdf-extractable
    text content stream (no external PDF-writing library needed). Copied from
    test_cv_extraction_agent.py."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> "
        b"/MediaBox [0 0 612 792] /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    content = f"BT /F1 24 Tf 100 700 Td ({text}) Tj ET".encode("latin-1")
    objects.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")

    buf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(buf))
        buf += f"{i} 0 obj\n".encode()
        buf += obj
        buf += b"\nendobj\n"
    xref_offset = len(buf)
    buf += f"xref\n0 {len(objects) + 1}\n".encode()
    buf += b"0000000000 65535 f\r\n"
    for off in offsets[1:]:
        buf += f"{off:010d} 00000 n\r\n".encode()
    buf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF".encode()
    return bytes(buf)


FIXTURE_PDF_BYTES = _build_fixture_pdf_bytes(
    "Jane Doe Senior Backend Engineer Acme Corp 2019 2024 "
    "Python AWS PostgreSQL Docker Kubernetes State University BSc Computer Science"
)
NEAR_EMPTY_PDF_BYTES = _build_fixture_pdf_bytes("Jane Doe")


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )


async def _make_pending_cv_version(session_factory, user_id, cv_version_id, file_key, file_type, file_name):
    now = datetime.now(UTC).replace(tzinfo=None)
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            CVVersion(
                id=cv_version_id,
                userId=user_id,
                label="Software Engineer",
                fileKey=file_key,
                fileName=file_name,
                fileType=file_type,
                fileSizeBytes=1024,
                conversionStatus=Cvconversionstatus.PENDING,
                updatedAt=now,
            )
        )
        await session.commit()


async def _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id):
    s3.delete_object(Bucket=S3_BUCKET, Key=file_key)
    async with session_factory() as session:
        events = (
            await session.scalars(
                select(PipelineEvent).where(PipelineEvent.message.contains(cv_version_id))
            )
        ).all()
        for event in events:
            await session.delete(event)
        cv_version = await session.get(CVVersion, cv_version_id)
        if cv_version is not None:
            await session.delete(cv_version)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()
    await engine.dispose()


@pytest.mark.parametrize(
    ("file_type", "file_name"),
    [(Cvfiletype.MD, "cv.md"), (Cvfiletype.TXT, "cv.txt")],
)
@pytest.mark.asyncio
async def test_convert_cv_stores_text_verbatim_without_calling_the_llm(file_type, file_name):
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/{file_name}"
    s3 = _s3_client()
    content = "# Jane Doe\n\n## Experience\n\n- Senior Backend Engineer, Acme Corp\n"
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=content.encode("utf-8"))

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, file_type, file_name
    )

    try:
        async with session_factory() as session:
            cv_version = await convert_cv(
                session, cv_version_id, llm_provider=ExplodingLLMProvider()
            )
            assert cv_version.conversionStatus == Cvconversionstatus.CONVERTED
            assert cv_version.markdownContent == content
            assert cv_version.conversionError is None

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.conversionStatus == Cvconversionstatus.CONVERTED
            assert reloaded.markdownContent == content

            events = (
                await session.scalars(
                    select(PipelineEvent).where(PipelineEvent.message.contains(cv_version_id))
                )
            ).all()
            statuses = {e.status for e in events if e.stage == "convert"}
            assert {"STARTED", "SUCCEEDED"} <= statuses
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_convert_cv_marks_failed_for_a_type_it_does_not_yet_handle():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.docx"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=b"PK\x03\x04 docx stub")

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, Cvfiletype.DOCX, "cv.docx"
    )

    try:
        async with session_factory() as session:
            with pytest.raises(CVConversionError):
                await convert_cv(session, cv_version_id)

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.conversionStatus == Cvconversionstatus.FAILED
            assert reloaded.conversionError
            assert reloaded.markdownContent is None
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_convert_cv_normalises_a_pdf_via_one_llm_call():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=FIXTURE_PDF_BYTES)

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF, "cv.pdf"
    )
    provider = StubLLMProvider([NORMALISED_MARKDOWN])

    try:
        async with session_factory() as session:
            cv_version = await convert_cv(session, cv_version_id, llm_provider=provider)
            assert cv_version.conversionStatus == Cvconversionstatus.CONVERTED
            assert cv_version.markdownContent == NORMALISED_MARKDOWN
            assert cv_version.conversionError is None

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.markdownContent == NORMALISED_MARKDOWN
            events = (
                await session.scalars(
                    select(PipelineEvent).where(PipelineEvent.message.contains(cv_version_id))
                )
            ).all()
            statuses = {e.status for e in events if e.stage == "convert"}
            assert {"STARTED", "SUCCEEDED"} <= statuses
        assert provider.calls == 1
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_convert_cv_fails_a_pdf_with_no_extractable_text_without_calling_the_llm():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/scan.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=NEAR_EMPTY_PDF_BYTES)

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF, "scan.pdf"
    )

    try:
        async with session_factory() as session:
            with pytest.raises(CVConversionError):
                await convert_cv(session, cv_version_id, llm_provider=ExplodingLLMProvider())

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.conversionStatus == Cvconversionstatus.FAILED
            assert reloaded.markdownContent is None
            assert "text" in reloaded.conversionError.lower()
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_convert_cv_marks_pdf_failed_after_bounded_normalisation_retries():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=FIXTURE_PDF_BYTES)

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF, "cv.pdf"
    )
    provider = StubLLMProvider(["", "   ", ""])

    try:
        async with session_factory() as session:
            with pytest.raises(CVConversionError):
                await convert_cv(session, cv_version_id, llm_provider=provider)

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.conversionStatus == Cvconversionstatus.FAILED
            assert reloaded.conversionError
            assert reloaded.markdownContent is None
        # Bounded: exactly MAX_ATTEMPTS calls, never an unbounded loop, and no
        # fallback to the raw extracted text.
        assert provider.calls == MAX_ATTEMPTS
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_convert_cv_normalises_a_pdf_on_retry_after_one_empty_response():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=FIXTURE_PDF_BYTES)

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF, "cv.pdf"
    )
    provider = StubLLMProvider(["", NORMALISED_MARKDOWN])

    try:
        async with session_factory() as session:
            cv_version = await convert_cv(session, cv_version_id, llm_provider=provider)
            assert cv_version.conversionStatus == Cvconversionstatus.CONVERTED
            assert cv_version.markdownContent == NORMALISED_MARKDOWN
        assert provider.calls == 2
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)
