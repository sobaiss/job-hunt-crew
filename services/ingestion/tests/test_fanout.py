import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
import respx
from analysis.llm_provider import LLMProvider
from botocore.client import Config
from httpx import Response
from py_db.models import IngestionJob, IngestionJobOffer, JobOffer, Ingestionjobstatus, Ingestionmode, Jobofferextractionstatus, Joboffersourcesite, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.fanout import dedupe_and_cap_urls, link_and_process_offers, link_discovered_offers, process_job_offer
from ingestion.s3_client import S3_BUCKET, raw_scrape_key

FIXTURE_HTML = "<html><body><h1>Senior Backend Engineer</h1></body></html>"
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


def test_dedupe_and_cap_urls_caps_at_max_offers():
    urls = [f"https://example.com/jobs/{i}" for i in range(30)]

    retained = dedupe_and_cap_urls(urls, 25)

    assert len(retained) == 25
    assert retained == urls[:25]


def test_dedupe_and_cap_urls_removes_duplicates_preserving_order():
    urls = [
        "https://example.com/jobs/1",
        "https://example.com/jobs/2",
        "https://example.com/jobs/1",
        "https://example.com/jobs/3",
    ]

    retained = dedupe_and_cap_urls(urls, 25)

    assert retained == [
        "https://example.com/jobs/1",
        "https://example.com/jobs/2",
        "https://example.com/jobs/3",
    ]


@pytest.mark.asyncio
async def test_link_discovered_offers_caps_ingestion_job_offer_rows_at_max_offers():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    urls = [f"https://example.com/jobs/{uuid.uuid4()}" for _ in range(30)]

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.LISTING_URL,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=_now(),
            )
        )
        await session.commit()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            job_offers = await link_discovered_offers(session, ingestion_job, urls)

        assert len(job_offers) == 25

        async with session_factory() as session:
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            assert len(links) == 25

            offers = (
                await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(urls)))
            ).all()
            assert len(offers) == 25
    finally:
        async with session_factory() as session:
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            for link in links:
                await session.delete(link)
            await session.commit()

            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(urls)))).all()
            for offer in offers:
                await session.delete(offer)
            job = await session.get(IngestionJob, ingestion_job_id)
            if job is not None:
                await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_link_discovered_offers_reuses_globally_deduplicated_job_offer():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    shared_url = f"https://example.com/jobs/{uuid.uuid4()}"

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.LISTING_URL,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=_now(),
            )
        )
        await session.commit()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            job_offers = await link_discovered_offers(session, ingestion_job, [shared_url, shared_url])

        # Same URL discovered twice -> deduped to a single retained URL,
        # and only one JobOffer row exists globally for that sourceUrl.
        assert len(job_offers) == 1

        async with session_factory() as session:
            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl == shared_url))).all()
            assert len(offers) == 1

            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            assert len(links) == 1
    finally:
        async with session_factory() as session:
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            for link in links:
                await session.delete(link)
            await session.commit()

            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl == shared_url))).all()
            for offer in offers:
                await session.delete(offer)
            job = await session.get(IngestionJob, ingestion_job_id)
            if job is not None:
                await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_link_and_process_offers_produces_five_linked_ready_job_offers():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    urls = [f"https://example.com/jobs/{uuid.uuid4()}" for _ in range(5)]
    s3 = _s3_client()
    processed: list[JobOffer] = []

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=datetime.now(UTC).replace(tzinfo=None)))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.LISTING_URL,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()

    try:
        with respx.mock(assert_all_called=True) as mock:
            for url in urls:
                mock.get(url).mock(return_value=Response(200, text=FIXTURE_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                provider = StubLLMProvider()
                processed = await link_and_process_offers(session, ingestion_job, urls, llm_provider=provider)

        # PRD 8.4 step 4 / M3-T4 verify: a fixture listing page with 5 links
        # produces exactly 5 linked JobOffer rows, each run through the Mode
        # 1 pipeline (scrape -> extract) to a terminal READY status.
        assert len(processed) == 5
        assert all(offer.extractionStatus == Jobofferextractionstatus.READY for offer in processed)
        assert all(offer.structuredData is not None for offer in processed)

        async with session_factory() as session:
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            assert len(links) == 5

            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(urls)))).all()
            assert len(offers) == 5
            assert all(offer.extractionStatus == Jobofferextractionstatus.READY for offer in offers)
    finally:
        for job_offer in processed:
            try:
                s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(job_offer.id))
            except Exception:
                pass
        async with session_factory() as session:
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            for link in links:
                await session.delete(link)
            await session.commit()

            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(urls)))).all()
            for offer in offers:
                await session.delete(offer)
            job = await session.get(IngestionJob, ingestion_job_id)
            if job is not None:
                await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_process_job_offer_skips_already_ready_offer():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    url = f"https://example.com/jobs/{uuid.uuid4()}"

    async with session_factory() as session:
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=url,
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.READY,
                structuredData={"description": "already extracted", "requirements": []},
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()

    try:
        with respx.mock(assert_all_called=False):
            # No route registered for `url` at all: if process_job_offer
            # attempted to re-scrape an already-READY offer, respx would
            # raise on the unmocked request.
            async with session_factory() as session:
                job_offer = await session.get(JobOffer, job_offer_id)
                provider = StubLLMProvider()
                result = await process_job_offer(session, job_offer, llm_provider=provider)

        assert result.extractionStatus == Jobofferextractionstatus.READY
        assert provider.calls == 0
    finally:
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_process_job_offer_continues_past_scrape_failure_without_raising():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    unreachable_url = f"https://example.com/jobs/unreachable-{uuid.uuid4()}"

    async with session_factory() as session:
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=unreachable_url,
                sourceSite=Joboffersourcesite.OTHER,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()

    try:
        with respx.mock(assert_all_called=True) as mock:
            mock.get(unreachable_url).mock(return_value=Response(404))
            async with session_factory() as session:
                job_offer = await session.get(JobOffer, job_offer_id)
                provider = StubLLMProvider()
                # Must not raise: one offer's scrape failure shouldn't abort
                # the fan-out for the rest of a listing's offers.
                result = await process_job_offer(session, job_offer, llm_provider=provider)

        assert result.extractionStatus == Jobofferextractionstatus.FAILED
        assert result.errorMessage
        assert provider.calls == 0
    finally:
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()
