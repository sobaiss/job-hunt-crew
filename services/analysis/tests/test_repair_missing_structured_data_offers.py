import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import JobOffer, Jobofferextractionstatus, Joboffersourcesite
from py_db.session import make_engine, make_session_factory

from analysis.job_offer_extraction_agent import ExtractionError
from analysis.repair_missing_structured_data_offers import (
    SelectFn,
    repair_missing_structured_data_offers,
    select_offers_missing_structured_data,
)


def _offer(
    *,
    extraction_status: Jobofferextractionstatus,
    structured_data: dict | None,
    title: str | None = "Some Title",
    raw_content_key: str | None = "raw-scrapes/fixture.html",
) -> JobOffer:
    job_offer_id = f"test-{uuid.uuid4()}"
    # Passing structuredData=None explicitly (vs. leaving the kwarg unset)
    # would persist as JSON 'null' rather than SQL NULL for this JSONB
    # column, which select_offers_missing_structured_data's `.is_(None)`
    # does not match -- so the None case must leave the attribute untouched.
    kwargs: dict = {}
    if structured_data is not None:
        kwargs["structuredData"] = structured_data
    return JobOffer(
        id=job_offer_id,
        sourceUrl=f"https://example.com/jobs/{job_offer_id}",
        sourceSite=Joboffersourcesite.OTHER,
        extractionStatus=extraction_status,
        title=title,
        rawContentKey=raw_content_key,
        updatedAt=datetime.now(UTC).replace(tzinfo=None),
        **kwargs,
    )


def _select_fn_for(offer_ids: list[str]) -> SelectFn:
    """Scopes a test to exactly its own fixture rows instead of the real
    select_offers_missing_structured_data, which runs an unscoped,
    table-wide query. Delegation tests below pair this with a fake
    extract_fn that mutates whatever `repair_missing_structured_data_offers`
    hands it -- letting that real query through here once matched real,
    already-broken production rows in the shared dev DB and the fake
    extract_fn overwrote their structuredData with placeholder junk.
    """

    async def _select_fn(session):
        offers = []
        for offer_id in offer_ids:
            offer = await session.get(JobOffer, offer_id)
            if offer is not None:
                offers.append(offer)
        return offers

    return _select_fn


async def _cleanup(session_factory, offer_ids: list[str]) -> None:
    async with session_factory() as session:
        for offer_id in offer_ids:
            job_offer = await session.get(JobOffer, offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
        await session.commit()


@pytest.mark.asyncio
async def test_select_offers_missing_structured_data_excludes_complete_and_non_ready():
    engine = make_engine()
    session_factory = make_session_factory(engine)

    missing_structured_data = _offer(
        extraction_status=Jobofferextractionstatus.READY, structured_data=None
    )
    already_complete = _offer(
        extraction_status=Jobofferextractionstatus.READY,
        structured_data={"description": "x", "requirements": []},
    )
    not_ready_yet = _offer(
        extraction_status=Jobofferextractionstatus.SCRAPED, structured_data=None
    )
    offers = [missing_structured_data, already_complete, not_ready_yet]

    try:
        async with session_factory() as session:
            session.add_all(offers)
            await session.commit()

        async with session_factory() as session:
            selected = await select_offers_missing_structured_data(session)
            selected_ids = {offer.id for offer in selected}

        # This query is unscoped (table-wide), so other real rows may
        # legitimately also match in a shared dev DB -- assert only on this
        # test's own fixtures rather than exact set equality.
        assert missing_structured_data.id in selected_ids
        assert already_complete.id not in selected_ids
        assert not_ready_yet.id not in selected_ids
    finally:
        await _cleanup(session_factory, [offer.id for offer in offers])
        await engine.dispose()


@pytest.mark.asyncio
async def test_repair_missing_structured_data_offers_delegates_to_extraction_step_per_offer():
    engine = make_engine()
    session_factory = make_session_factory(engine)

    missing_1 = _offer(
        extraction_status=Jobofferextractionstatus.READY, structured_data=None
    )
    missing_2 = _offer(
        extraction_status=Jobofferextractionstatus.READY, structured_data=None
    )
    already_complete = _offer(
        extraction_status=Jobofferextractionstatus.READY,
        structured_data={"description": "x", "requirements": []},
    )
    offers = [missing_1, missing_2, already_complete]

    calls: list[str] = []

    async def fake_extract_fn(session, job_offer_id: str) -> JobOffer:
        calls.append(job_offer_id)
        job_offer = await session.get(JobOffer, job_offer_id)
        job_offer.structuredData = {"description": "Repaired", "requirements": []}
        await session.commit()
        return job_offer

    try:
        async with session_factory() as session:
            session.add_all(offers)
            await session.commit()

        async with session_factory() as session:
            repaired_ids = await repair_missing_structured_data_offers(
                session,
                extract_fn=fake_extract_fn,
                select_fn=_select_fn_for([missing_1.id, missing_2.id]),
            )

        assert set(calls) == {missing_1.id, missing_2.id}
        assert set(repaired_ids) == {missing_1.id, missing_2.id}

        async with session_factory() as session:
            reloaded = await session.get(JobOffer, missing_1.id)
            assert reloaded.structuredData == {
                "description": "Repaired",
                "requirements": [],
            }
    finally:
        await _cleanup(session_factory, [offer.id for offer in offers])
        await engine.dispose()


@pytest.mark.asyncio
async def test_repair_missing_structured_data_offers_skips_offer_that_fails_extraction_again():
    engine = make_engine()
    session_factory = make_session_factory(engine)

    still_unresolvable = _offer(
        extraction_status=Jobofferextractionstatus.READY, structured_data=None
    )
    repairable = _offer(
        extraction_status=Jobofferextractionstatus.READY, structured_data=None
    )
    offers = [still_unresolvable, repairable]

    async def fake_extract_fn(session, job_offer_id: str) -> JobOffer:
        if job_offer_id == still_unresolvable.id:
            raise ExtractionError("still no structuredData")
        job_offer = await session.get(JobOffer, job_offer_id)
        job_offer.structuredData = {"description": "Repaired", "requirements": []}
        await session.commit()
        return job_offer

    try:
        async with session_factory() as session:
            session.add_all(offers)
            await session.commit()

        async with session_factory() as session:
            repaired_ids = await repair_missing_structured_data_offers(
                session,
                extract_fn=fake_extract_fn,
                select_fn=_select_fn_for([still_unresolvable.id, repairable.id]),
            )

        assert repaired_ids == [repairable.id]
    finally:
        await _cleanup(session_factory, [offer.id for offer in offers])
        await engine.dispose()
