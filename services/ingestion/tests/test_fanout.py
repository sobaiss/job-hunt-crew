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
    CVVersion,
    Cvconversionstatus,
    Cvfiletype,
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    PipelineEvent,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.fanout import (
    dedupe_and_cap_urls,
    link_and_process_offers,
    link_discovered_offers,
    process_job_offer,
    update_ingestion_job_aggregate,
)
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
            # PipelineEvent.ingestionJobId (M6-T3) has ON DELETE CASCADE at
            # the DB level, but SQLAlchemy's default relationship handling
            # nulls rather than deletes orphaned children when the parent
            # is removed via the ORM — so delete these explicitly first,
            # rather than relying on the DB-level cascade.
            events = (
                await session.scalars(
                    select(PipelineEvent).where(PipelineEvent.ingestionJobId == ingestion_job_id)
                )
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
            # process_job_offer, called here with no ingestion_job_id, tags
            # its scrape-stage PipelineEvent rows (M6-T3) only via
            # job_offer_id embedded in the message — no FK to
            # cascade-delete them, so clean up explicitly.
            events = (
                await session.scalars(
                    select(PipelineEvent).where(PipelineEvent.message.contains(job_offer_id))
                )
            ).all()
            for event in events:
                await session.delete(event)
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_link_and_process_offers_rolls_up_partially_completed_with_one_forced_failure():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    urls = [f"https://example.com/jobs/{uuid.uuid4()}" for _ in range(5)]
    failing_url = urls[2]
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
                if url == failing_url:
                    mock.get(url).mock(return_value=Response(404))
                else:
                    mock.get(url).mock(return_value=Response(200, text=FIXTURE_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                provider = StubLLMProvider()
                processed = await link_and_process_offers(session, ingestion_job, urls, llm_provider=provider)

        # M3-T5 verify: fixture run with 1 forced failure among 5 offers
        # yields status=PARTIALLY_COMPLETED, failedCount=1.
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            assert ingestion_job.discoveredCount == 5
            assert ingestion_job.scrapedCount == 4
            assert ingestion_job.failedCount == 1
            assert ingestion_job.status == Ingestionjobstatus.PARTIALLY_COMPLETED
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
            # PipelineEvent.ingestionJobId (M6-T3) has ON DELETE CASCADE at
            # the DB level, but SQLAlchemy's default relationship handling
            # nulls rather than deletes orphaned children when the parent
            # is removed via the ORM — so delete these explicitly first,
            # rather than relying on the DB-level cascade.
            events = (
                await session.scalars(
                    select(PipelineEvent).where(PipelineEvent.ingestionJobId == ingestion_job_id)
                )
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
        await engine.dispose()


@pytest.mark.asyncio
async def test_update_ingestion_job_aggregate_completed_when_all_ready():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    url = f"https://example.com/jobs/{uuid.uuid4()}"

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
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=url,
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.READY,
                structuredData={"description": "ready", "requirements": []},
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        session.add(IngestionJobOffer(id=f"link-{uuid.uuid4()}", ingestionJobId=ingestion_job_id, jobOfferId=job_offer_id))
        await session.commit()

    try:
        async with session_factory() as session:
            ingestion_job = await update_ingestion_job_aggregate(session, ingestion_job_id)

        assert ingestion_job.discoveredCount == 1
        assert ingestion_job.scrapedCount == 1
        assert ingestion_job.failedCount == 0
        assert ingestion_job.status == Ingestionjobstatus.COMPLETED
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

            offer = await session.get(JobOffer, job_offer_id)
            if offer is not None:
                await session.delete(offer)
            job = await session.get(IngestionJob, ingestion_job_id)
            if job is not None:
                await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()


async def _seed_scout_job(session_factory, *, with_cv_version=True):
    user_id = f"test-user-{uuid.uuid4()}"
    # Scout.cvVersionId is a required FK, so a real CVVersion row always
    # exists; `with_cv_version=False` only omits it from the IngestionJob,
    # mirroring the legacy-row case `create_analyses_for_ready_offers` also
    # no-ops on.
    scout_cv_version_id = f"test-cv-{uuid.uuid4()}"
    ingestion_job_cv_version_id = scout_cv_version_id if with_cv_version else None
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    scout_id = f"test-scout-{uuid.uuid4()}"
    scout_run_id = f"test-scout-run-{uuid.uuid4()}"

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            CVVersion(
                id=scout_cv_version_id,
                userId=user_id,
                label="CV",
                fileKey="cv/x.pdf",
                fileName="x.pdf",
                fileType=Cvfiletype.PDF,
                fileSizeBytes=1234,
                conversionStatus=Cvconversionstatus.CONVERTED,
                markdownContent="Senior Python Backend Engineer with AWS Kubernetes experience",
                updatedAt=_now(),
            )
        )
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.SITE_SEARCH,
                cvVersionId=ingestion_job_cv_version_id,
                scoutRunId=scout_run_id,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=_now(),
            )
        )
        session.add(
            Scout(
                id=scout_id,
                userId=user_id,
                label="Backend — Remote",
                cvVersionId=scout_cv_version_id,
                targetSiteKeys=["FRANCE_TRAVAIL"],
                filters={},
                matchThreshold=70,
                status=Scoutstatus.ACTIVE,
                updatedAt=_now(),
            )
        )
        session.add(ScoutRun(id=scout_run_id, scoutId=scout_id, status=Scoutrunstatus.RUNNING))
        await session.commit()

    return user_id, scout_cv_version_id, ingestion_job_id, scout_id, scout_run_id


async def _cleanup_scout_job(session_factory, *, user_id, cv_version_id, ingestion_job_id, scout_id, scout_run_id, urls):
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
        events = (
            await session.scalars(select(PipelineEvent).where(PipelineEvent.ingestionJobId == ingestion_job_id))
        ).all()
        for event in events:
            await session.delete(event)
        job = await session.get(IngestionJob, ingestion_job_id)
        if job is not None:
            await session.delete(job)
        run = await session.get(ScoutRun, scout_run_id)
        if run is not None:
            await session.delete(run)
        scout = await session.get(Scout, scout_id)
        if scout is not None:
            await session.delete(scout)
        if cv_version_id:
            cv = await session.get(CVVersion, cv_version_id)
            if cv is not None:
                await session.delete(cv)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


@pytest.mark.asyncio
async def test_scout_job_extraction_ceiling_skips_low_similarity_offer(monkeypatch):
    """issue #55 follow-up: a Scout job's extraction ceiling now gates
    extraction itself, not just Analysis creation — the offer least similar
    to the base CV is scraped but never extracted (no extraction-LLM call
    spent on it), and the job still reaches a terminal COMPLETED status
    rather than getting stuck RUNNING on the un-extracted offer."""
    monkeypatch.setenv("SCOUT_MAX_ANALYSES_PER_RUN", "1")
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_version_id, ingestion_job_id, scout_id, scout_run_id = await _seed_scout_job(session_factory)
    good_url = f"https://example.com/jobs/{uuid.uuid4()}"
    bad_url = f"https://example.com/jobs/{uuid.uuid4()}"
    urls = [good_url, bad_url]
    good_html = "<html><body>Senior Python Backend Engineer AWS Kubernetes</body></html>"
    bad_html = "<html><body>Pastry Chef cake decoration dessert plating</body></html>"
    s3 = _s3_client()
    processed: list[JobOffer] = []

    try:
        with respx.mock(assert_all_called=True) as mock:
            mock.get(good_url).mock(return_value=Response(200, text=good_html))
            mock.get(bad_url).mock(return_value=Response(200, text=bad_html))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                provider = StubLLMProvider()
                processed = await link_and_process_offers(session, ingestion_job, urls, llm_provider=provider)

        assert provider.calls == 1

        by_url = {offer.sourceUrl: offer for offer in processed}
        assert by_url[good_url].extractionStatus == Jobofferextractionstatus.READY
        assert by_url[good_url].structuredData is not None
        assert by_url[bad_url].extractionStatus == Jobofferextractionstatus.SCRAPED
        assert by_url[bad_url].structuredData is None

        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
        assert ingestion_job.extractionSkippedCount == 1
        assert ingestion_job.status == Ingestionjobstatus.COMPLETED
    finally:
        for job_offer in processed:
            try:
                s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(job_offer.id))
            except Exception:
                pass
        await _cleanup_scout_job(
            session_factory,
            user_id=user_id,
            cv_version_id=cv_version_id,
            ingestion_job_id=ingestion_job_id,
            scout_id=scout_id,
            scout_run_id=scout_run_id,
            urls=urls,
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_scout_job_without_cv_version_extracts_every_offer_unchanged(monkeypatch):
    """A Scout job with no cvVersionId (legacy row / bad state) has nothing
    to rank against, so it falls back to the manual flow's extract-everyone
    behaviour rather than skipping offers it can't rank."""
    monkeypatch.setenv("SCOUT_MAX_ANALYSES_PER_RUN", "1")
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_version_id, ingestion_job_id, scout_id, scout_run_id = await _seed_scout_job(
        session_factory, with_cv_version=False
    )
    urls = [f"https://example.com/jobs/{uuid.uuid4()}" for _ in range(2)]
    s3 = _s3_client()
    processed: list[JobOffer] = []

    try:
        with respx.mock(assert_all_called=True) as mock:
            for url in urls:
                mock.get(url).mock(return_value=Response(200, text=FIXTURE_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                provider = StubLLMProvider()
                processed = await link_and_process_offers(session, ingestion_job, urls, llm_provider=provider)

        assert provider.calls == 2
        assert all(offer.extractionStatus == Jobofferextractionstatus.READY for offer in processed)

        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
        assert ingestion_job.extractionSkippedCount == 0
        assert ingestion_job.status == Ingestionjobstatus.COMPLETED
    finally:
        for job_offer in processed:
            try:
                s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(job_offer.id))
            except Exception:
                pass
        await _cleanup_scout_job(
            session_factory,
            user_id=user_id,
            cv_version_id=cv_version_id,
            ingestion_job_id=ingestion_job_id,
            scout_id=scout_id,
            scout_run_id=scout_run_id,
            urls=urls,
        )
        await engine.dispose()
