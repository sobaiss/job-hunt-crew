import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import JobOffer, Jobofferextractionstatus, Joboffersourcesite
from py_db.session import make_engine, make_session_factory

from analysis.job_offer_extraction_agent import ExtractionError
from analysis.repair_missing_title_offers import (
    repair_missing_title_offers,
    select_offers_missing_title,
)


def _offer(
    *,
    source_site: Joboffersourcesite,
    title: str | None,
    raw_content_key: str | None = "raw-scrapes/fixture.html",
) -> JobOffer:
    job_offer_id = f"test-{uuid.uuid4()}"
    return JobOffer(
        id=job_offer_id,
        sourceUrl=f"https://example.com/jobs/{job_offer_id}",
        sourceSite=source_site,
        extractionStatus=(
            Jobofferextractionstatus.READY
            if title
            else Jobofferextractionstatus.SCRAPED
        ),
        title=title,
        rawContentKey=raw_content_key,
        updatedAt=datetime.now(UTC).replace(tzinfo=None),
    )


async def _cleanup(session_factory, offer_ids: list[str]) -> None:
    async with session_factory() as session:
        for offer_id in offer_ids:
            job_offer = await session.get(JobOffer, offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
        await session.commit()


@pytest.mark.asyncio
async def test_select_offers_missing_title_excludes_complete_and_france_travail_and_unscraped():
    engine = make_engine()
    session_factory = make_session_factory(engine)

    missing_title = _offer(source_site=Joboffersourcesite.OTHER, title=None)
    already_complete = _offer(
        source_site=Joboffersourcesite.OTHER, title="Backend Engineer"
    )
    france_travail_missing_title = _offer(
        source_site=Joboffersourcesite.FRANCE_TRAVAIL, title=None
    )
    never_scraped = _offer(
        source_site=Joboffersourcesite.LINKEDIN, title=None, raw_content_key=None
    )
    offers = [
        missing_title,
        already_complete,
        france_travail_missing_title,
        never_scraped,
    ]

    try:
        async with session_factory() as session:
            session.add_all(offers)
            await session.commit()

        async with session_factory() as session:
            selected = await select_offers_missing_title(session)
            selected_ids = {offer.id for offer in selected}

        assert selected_ids == {missing_title.id}
    finally:
        await _cleanup(session_factory, [offer.id for offer in offers])
        await engine.dispose()


@pytest.mark.asyncio
async def test_repair_missing_title_offers_delegates_to_extraction_step_per_offer():
    engine = make_engine()
    session_factory = make_session_factory(engine)

    missing_title_1 = _offer(source_site=Joboffersourcesite.OTHER, title=None)
    missing_title_2 = _offer(source_site=Joboffersourcesite.LINKEDIN, title=None)
    already_complete = _offer(
        source_site=Joboffersourcesite.OTHER, title="Backend Engineer"
    )
    france_travail_missing_title = _offer(
        source_site=Joboffersourcesite.FRANCE_TRAVAIL, title=None
    )
    offers = [
        missing_title_1,
        missing_title_2,
        already_complete,
        france_travail_missing_title,
    ]

    calls: list[str] = []

    async def fake_extract_fn(session, job_offer_id: str) -> JobOffer:
        calls.append(job_offer_id)
        job_offer = await session.get(JobOffer, job_offer_id)
        job_offer.title = "Repaired Title"
        await session.commit()
        return job_offer

    try:
        async with session_factory() as session:
            session.add_all(offers)
            await session.commit()

        async with session_factory() as session:
            repaired_ids = await repair_missing_title_offers(
                session, extract_fn=fake_extract_fn
            )

        assert set(calls) == {missing_title_1.id, missing_title_2.id}
        assert set(repaired_ids) == {missing_title_1.id, missing_title_2.id}

        async with session_factory() as session:
            reloaded = await session.get(JobOffer, missing_title_1.id)
            assert reloaded.title == "Repaired Title"
    finally:
        await _cleanup(session_factory, [offer.id for offer in offers])
        await engine.dispose()


@pytest.mark.asyncio
async def test_repair_missing_title_offers_skips_offer_that_fails_extraction_again():
    engine = make_engine()
    session_factory = make_session_factory(engine)

    still_unresolvable = _offer(source_site=Joboffersourcesite.OTHER, title=None)
    repairable = _offer(source_site=Joboffersourcesite.OTHER, title=None)
    offers = [still_unresolvable, repairable]

    async def fake_extract_fn(session, job_offer_id: str) -> JobOffer:
        if job_offer_id == still_unresolvable.id:
            raise ExtractionError("still no title")
        job_offer = await session.get(JobOffer, job_offer_id)
        job_offer.title = "Repaired Title"
        await session.commit()
        return job_offer

    try:
        async with session_factory() as session:
            session.add_all(offers)
            await session.commit()

        async with session_factory() as session:
            repaired_ids = await repair_missing_title_offers(
                session, extract_fn=fake_extract_fn
            )

        assert repaired_ids == [repairable.id]
    finally:
        await _cleanup(session_factory, [offer.id for offer in offers])
        await engine.dispose()
