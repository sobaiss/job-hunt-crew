import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
import respx
from analysis.llm_provider import LLMProvider
from botocore.client import Config
from httpx import Response
from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    PipelineEvent,
    SiteConfig,
    Siteconfigsitekey,
    Jobofferextractionstatus,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.s3_client import S3_BUCKET, raw_scrape_key
from ingestion.single_url_pipeline import run_single_url_ingestion

FIXTURE_OFFER_HTML = "<html><body><h1>Senior Backend Engineer</h1></body></html>"
VALID_LLM_OUTPUT = json.dumps(
    {
        "description": "Senior Backend Engineer role.",
        "requirements": ["5+ years Python"],
        "salary": None,
        "contractType": "full_time",
        "remotePolicy": "remote",
        "seniority": "senior",
    }
)


class StubLLMProvider(LLMProvider):
    def __init__(self, response=VALID_LLM_OUTPUT):
        self._response = response
        self.calls = 0

    def generate(self, *, system: str, prompt: str) -> str:
        self.calls += 1
        return self._response


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


async def _seed_job(session_factory, *, input_url):
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.SINGLE_URL,
                inputUrl=input_url,
                maxOffers=1,
                status=Ingestionjobstatus.PENDING,
                updatedAt=_now(),
            )
        )
        await session.commit()
    return user_id, ingestion_job_id


async def _cleanup(session_factory, *, user_id, ingestion_job_id, source_urls=()):
    s3 = _s3_client()
    async with session_factory() as session:
        offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(source_urls)))).all()
        for offer in offers:
            try:
                s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(offer.id))
            except Exception:
                pass

        links = (
            await session.scalars(
                select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
            )
        ).all()
        for link in links:
            await session.delete(link)
        await session.commit()

        for offer in offers:
            await session.delete(offer)

        events = (
            await session.scalars(select(PipelineEvent).where(PipelineEvent.ingestionJobId == ingestion_job_id))
        ).all()
        for event in events:
            await session.delete(event)

        job = await session.get(IngestionJob, ingestion_job_id)
        if job is not None:
            await session.delete(job)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


@pytest.mark.asyncio
async def test_run_single_url_ingestion_fresh_url_scrapes_extracts_and_links_ready_offer():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://jobs.example.com/offer/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(session_factory, input_url=source_url)

    try:
        with respx.mock:
            respx.mock.get(source_url).mock(return_value=Response(200, text=FIXTURE_OFFER_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_single_url_ingestion(
                    session, ingestion_job, llm_provider=StubLLMProvider()
                )

        assert result.status == Ingestionjobstatus.COMPLETED
        assert result.discoveredCount == 1
        assert result.scrapedCount == 1
        assert result.errorMessage is None

        async with session_factory() as session:
            offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == source_url))
            assert offer.extractionStatus == Jobofferextractionstatus.READY
            assert offer.sourceSite == Joboffersourcesite.OTHER
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(
                        IngestionJobOffer.ingestionJobId == ingestion_job_id
                    )
                )
            ).all()
            assert len(links) == 1
    finally:
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_single_url_ingestion_matches_source_site_from_enabled_site_config():
    """The domain of `inputUrl` is matched against the enabled SiteConfig
    rows (seeded by packages/prisma/prisma/seed.js) so the JobOffer records
    the real sourceSite rather than the OTHER fallback (PRD Section 8.3
    step 3)."""
    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://www.linkedin.com/jobs/view/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(session_factory, input_url=source_url)

    async with session_factory() as session:
        seeded = await session.scalar(
            select(SiteConfig).where(SiteConfig.siteKey == Siteconfigsitekey.LINKEDIN)
        )
    if seeded is None or not seeded.enabled:
        pytest.skip("LinkedIn SiteConfig not seeded in this database")

    try:
        with respx.mock:
            respx.mock.get(source_url).mock(return_value=Response(200, text=FIXTURE_OFFER_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                await run_single_url_ingestion(session, ingestion_job, llm_provider=StubLLMProvider())

        async with session_factory() as session:
            offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == source_url))
            assert offer.sourceSite == Joboffersourcesite.LINKEDIN
    finally:
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_single_url_ingestion_reuses_already_ready_offer_without_rescraping():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://jobs.example.com/offer/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(session_factory, input_url=source_url)

    async with session_factory() as session:
        session.add(
            JobOffer(
                id=str(uuid.uuid4()),
                sourceUrl=source_url,
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.READY,
                rawContentKey="raw-scrapes/pre-existing.html",
                updatedAt=_now(),
            )
        )
        await session.commit()

    stub = StubLLMProvider()
    try:
        with respx.mock:
            # No route registered: any HTTP fetch would raise, proving the
            # already-READY offer is not re-scraped.
            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_single_url_ingestion(session, ingestion_job, llm_provider=stub)

        assert result.status == Ingestionjobstatus.COMPLETED
        assert result.discoveredCount == 1
        assert stub.calls == 0

        async with session_factory() as session:
            offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == source_url))
            assert offer.rawContentKey == "raw-scrapes/pre-existing.html"
    finally:
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_single_url_ingestion_retries_previously_failed_offer():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://jobs.example.com/offer/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(session_factory, input_url=source_url)

    async with session_factory() as session:
        session.add(
            JobOffer(
                id=str(uuid.uuid4()),
                sourceUrl=source_url,
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.FAILED,
                errorMessage="Failed to fetch: 503",
                updatedAt=_now(),
            )
        )
        await session.commit()

    try:
        with respx.mock:
            respx.mock.get(source_url).mock(return_value=Response(200, text=FIXTURE_OFFER_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_single_url_ingestion(
                    session, ingestion_job, llm_provider=StubLLMProvider()
                )

        assert result.status == Ingestionjobstatus.COMPLETED
        assert result.scrapedCount == 1

        async with session_factory() as session:
            offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == source_url))
            assert offer.extractionStatus == Jobofferextractionstatus.READY
            assert offer.errorMessage is None
    finally:
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_single_url_ingestion_scrape_failure_marks_job_failed():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://jobs.example.com/offer/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(session_factory, input_url=source_url)

    try:
        with respx.mock:
            respx.mock.get(source_url).mock(return_value=Response(404))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_single_url_ingestion(
                    session, ingestion_job, llm_provider=StubLLMProvider()
                )

        assert result.status == Ingestionjobstatus.FAILED
        assert result.errorMessage
        assert result.discoveredCount == 1
        assert result.failedCount == 1
    finally:
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()
