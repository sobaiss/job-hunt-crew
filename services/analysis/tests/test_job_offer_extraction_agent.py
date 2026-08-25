import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
from botocore.client import Config
from py_db.models import JobOffer, Jobofferextractionstatus, Joboffersourcesite
from py_db.session import make_engine, make_session_factory

from analysis.job_offer_extraction_agent import (
    MAX_ATTEMPTS,
    ExtractionError,
    extract_job_offer,
)
from analysis.llm_provider import LLMProvider
from analysis.s3_client import S3_BUCKET

FIXTURE_HTML = "<html><body><h1>Senior Backend Engineer</h1><p>5 years Python required.</p></body></html>"
VALID_LLM_OUTPUT = json.dumps(
    {
        "description": "Senior Backend Engineer role focused on Python services.",
        "requirements": ["5+ years Python", "AWS experience"],
        "salary": "€60k-€75k",
        "contractType": "full_time",
        "remotePolicy": "hybrid",
        "seniority": "senior",
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


async def _make_scraped_job_offer(session_factory, job_offer_id, raw_content_key):
    async with session_factory() as session:
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.SCRAPED,
                rawContentKey=raw_content_key,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_extract_job_offer_structures_content_and_sets_ready():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    raw_content_key = f"raw-scrapes/{job_offer_id}.html"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=raw_content_key, Body=FIXTURE_HTML.encode("utf-8"), ContentType="text/html")

    await _make_scraped_job_offer(session_factory, job_offer_id, raw_content_key)
    provider = StubLLMProvider([VALID_LLM_OUTPUT])

    try:
        async with session_factory() as session:
            job_offer = await extract_job_offer(session, job_offer_id, llm_provider=provider)
            assert job_offer.extractionStatus == Jobofferextractionstatus.READY
            assert job_offer.structuredData["description"]
            assert job_offer.structuredData["requirements"] == ["5+ years Python", "AWS experience"]

        async with session_factory() as session:
            reloaded = await session.get(JobOffer, job_offer_id)
            assert reloaded.extractionStatus == Jobofferextractionstatus.READY
            assert "description" in reloaded.structuredData
            assert "requirements" in reloaded.structuredData
        assert provider.calls == 1
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=raw_content_key)
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_extract_job_offer_marks_failed_after_bounded_retries_on_malformed_output():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    raw_content_key = f"raw-scrapes/{job_offer_id}.html"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=raw_content_key, Body=FIXTURE_HTML.encode("utf-8"), ContentType="text/html")

    await _make_scraped_job_offer(session_factory, job_offer_id, raw_content_key)
    provider = StubLLMProvider(["not valid json"])

    try:
        async with session_factory() as session:
            with pytest.raises(ExtractionError):
                await extract_job_offer(session, job_offer_id, llm_provider=provider)

        async with session_factory() as session:
            reloaded = await session.get(JobOffer, job_offer_id)
            assert reloaded.extractionStatus == Jobofferextractionstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.structuredData is None
        # Bounded retries: exactly MAX_ATTEMPTS calls, never an unbounded loop.
        assert provider.calls == MAX_ATTEMPTS
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=raw_content_key)
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_extract_job_offer_succeeds_on_retry_after_one_malformed_attempt():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    raw_content_key = f"raw-scrapes/{job_offer_id}.html"
    s3 = _s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=raw_content_key, Body=FIXTURE_HTML.encode("utf-8"), ContentType="text/html")

    await _make_scraped_job_offer(session_factory, job_offer_id, raw_content_key)
    provider = StubLLMProvider(["not valid json", VALID_LLM_OUTPUT])

    try:
        async with session_factory() as session:
            job_offer = await extract_job_offer(session, job_offer_id, llm_provider=provider)
            assert job_offer.extractionStatus == Jobofferextractionstatus.READY
        assert provider.calls == 2
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=raw_content_key)
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()
