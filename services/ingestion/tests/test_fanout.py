import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import IngestionJob, IngestionJobOffer, JobOffer, Ingestionmode, Ingestionjobstatus, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.fanout import dedupe_and_cap_urls, link_discovered_offers


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
