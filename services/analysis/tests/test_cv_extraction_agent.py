import io
import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
from botocore.client import Config
from docx import Document
from py_db.models import CVVersion, Cvfiletype, Cvparsestatus, User
from py_db.session import make_engine, make_session_factory

from analysis.cv_extraction_agent import (
    MAX_ATTEMPTS,
    CVExtractionError,
    extract_cv,
)
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET

VALID_LLM_OUTPUT = json.dumps(
    {
        "skills": ["Python", "AWS", "PostgreSQL"],
        "experience": [
            {
                "title": "Senior Backend Engineer",
                "company": "Acme Corp",
                "startDate": "2021-01",
                "endDate": None,
                "description": "Built and maintained backend services.",
            }
        ],
        "education": [
            {
                "institution": "State University",
                "degree": "BSc",
                "field": "Computer Science",
                "startDate": "2013-09",
                "endDate": "2017-06",
            }
        ],
    }
)


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

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


def _build_fixture_pdf_bytes(text: str) -> bytes:
    """Hand-crafted minimal single-page PDF with a real, pypdf-extractable
    text content stream (no external PDF-writing library needed)."""
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


def _build_fixture_docx_bytes(text: str) -> bytes:
    document = Document()
    document.add_paragraph(text)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


FIXTURE_PDF_BYTES = _build_fixture_pdf_bytes(
    "Skills: Python, AWS. Experience: Senior Backend Engineer at Acme Corp."
)
FIXTURE_DOCX_BYTES = _build_fixture_docx_bytes(
    "Skills: Python, AWS. Experience: Senior Backend Engineer at Acme Corp."
)


async def _make_pending_cv_version(session_factory, user_id, cv_version_id, file_key, file_type):
    now = datetime.now(UTC).replace(tzinfo=None)
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            CVVersion(
                id=cv_version_id,
                userId=user_id,
                label="Software Engineer",
                fileKey=file_key,
                fileName="cv.pdf" if file_type == Cvfiletype.PDF else "cv.docx",
                fileType=file_type,
                fileSizeBytes=1024,
                parseStatus=Cvparsestatus.PENDING,
                updatedAt=now,
            )
        )
        await session.commit()


async def _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id):
    s3.delete_object(Bucket=S3_BUCKET, Key=file_key)
    async with session_factory() as session:
        cv_version = await session.get(CVVersion, cv_version_id)
        if cv_version is not None:
            await session.delete(cv_version)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()
    await engine.dispose()


@pytest.mark.asyncio
async def test_extract_cv_structures_pdf_and_sets_parsed():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=FIXTURE_PDF_BYTES, ContentType="application/pdf")

    await _make_pending_cv_version(session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF)
    provider = StubLLMProvider([VALID_LLM_OUTPUT])

    try:
        async with session_factory() as session:
            cv_version = await extract_cv(session, cv_version_id, llm_provider=provider)
            assert cv_version.parseStatus == Cvparsestatus.PARSED
            assert cv_version.structuredData["skills"] == ["Python", "AWS", "PostgreSQL"]
            assert cv_version.structuredData["experience"][0]["title"] == "Senior Backend Engineer"
            assert cv_version.structuredData["education"][0]["institution"] == "State University"
            assert cv_version.structuredDataVer == 1

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.parseStatus == Cvparsestatus.PARSED
            assert "skills" in reloaded.structuredData
            assert "experience" in reloaded.structuredData
            assert "education" in reloaded.structuredData
        assert provider.calls == 1
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_extract_cv_structures_docx_and_sets_parsed():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.docx"
    s3 = _s3_client()
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=file_key,
        Body=FIXTURE_DOCX_BYTES,
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    await _make_pending_cv_version(session_factory, user_id, cv_version_id, file_key, Cvfiletype.DOCX)
    provider = StubLLMProvider([VALID_LLM_OUTPUT])

    try:
        async with session_factory() as session:
            cv_version = await extract_cv(session, cv_version_id, llm_provider=provider)
            assert cv_version.parseStatus == Cvparsestatus.PARSED
            assert cv_version.structuredData["skills"]
        assert provider.calls == 1
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_extract_cv_marks_failed_after_bounded_retries_on_malformed_output():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=FIXTURE_PDF_BYTES, ContentType="application/pdf")

    await _make_pending_cv_version(session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF)
    provider = StubLLMProvider(["not valid json"])

    try:
        async with session_factory() as session:
            with pytest.raises(CVExtractionError):
                await extract_cv(session, cv_version_id, llm_provider=provider)

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.parseStatus == Cvparsestatus.FAILED
            assert reloaded.structuredData is None
        # Bounded retries: exactly MAX_ATTEMPTS calls, never an unbounded loop.
        assert provider.calls == MAX_ATTEMPTS
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)


@pytest.mark.asyncio
async def test_extract_cv_succeeds_on_retry_after_one_malformed_attempt():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=FIXTURE_PDF_BYTES, ContentType="application/pdf")

    await _make_pending_cv_version(session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF)
    provider = StubLLMProvider(["not valid json", VALID_LLM_OUTPUT])

    try:
        async with session_factory() as session:
            cv_version = await extract_cv(session, cv_version_id, llm_provider=provider)
            assert cv_version.parseStatus == Cvparsestatus.PARSED
        assert provider.calls == 2
    finally:
        await _cleanup(engine, session_factory, s3, file_key, user_id, cv_version_id)
