"""convert_cv (issue #16, slice 1): the MD / TXT branch stores the uploaded
file's UTF-8 text verbatim as CVVersion.markdownContent, with no LLM call.
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

from analysis.cv_conversion import CVConversionError, convert_cv
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET


class ExplodingLLMProvider(LLMProvider):
    """Any call is a test failure — the MD/TXT branch must not touch an LLM."""

    def generate(self, *, system: str, prompt: str) -> str:  # pragma: no cover
        raise AssertionError("convert_cv must not call the LLM for MD/TXT")


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
    file_key = f"cvs/{user_id}/{cv_version_id}/cv.pdf"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=b"%PDF-1.4 stub")

    await _make_pending_cv_version(
        session_factory, user_id, cv_version_id, file_key, Cvfiletype.PDF, "cv.pdf"
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
