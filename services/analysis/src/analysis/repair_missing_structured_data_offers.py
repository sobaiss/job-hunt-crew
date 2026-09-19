"""One-off repair task for JobOffer rows stuck extractionStatus=READY with
structuredData still null. Before this fix, `extract_job_offer`'s JSON-LD
tier flipped a JobOffer straight to READY as soon as a JobPosting JSON-LD
block resolved a title, even when that block had no `description` -- the LLM
tier that fills structuredData was never reached (see json_ld.
structured_data_from_job_posting and its caller in job_offer_extraction_agent).
`crew_task.run_crew_task`/`comparison_crew` both require a non-null
structuredData in addition to READY, so every offer caught by that gap is
silently unusable for analysis despite looking READY.

Re-runs extraction (`extract_job_offer`) against already-stored raw S3
content -- no re-scraping needed.

Deliberately manual: nothing schedules or triggers this automatically. Run
it once via `python -m analysis.repair_missing_structured_data_offers`
against the target environment's DATABASE_URL.
"""

import asyncio
from collections.abc import Awaitable, Callable

from py_db.models import JobOffer, Jobofferextractionstatus
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .job_offer_extraction_agent import ExtractionError, extract_job_offer

logger = get_logger(__name__)

ExtractFn = Callable[[AsyncSession, str], Awaitable[JobOffer]]
SelectFn = Callable[[AsyncSession], Awaitable[list[JobOffer]]]


async def select_offers_missing_structured_data(session: AsyncSession) -> list[JobOffer]:
    """Offers marked READY but with a null structuredData -- unusable by
    crew_task/comparison_crew despite their status, since both require a
    non-null structuredData in addition to extractionStatus=READY.
    """
    result = await session.scalars(
        select(JobOffer).where(
            JobOffer.extractionStatus == Jobofferextractionstatus.READY,
            JobOffer.structuredData.is_(None),
        )
    )
    return list(result.all())


async def repair_missing_structured_data_offers(
    session: AsyncSession,
    *,
    extract_fn: ExtractFn = extract_job_offer,
    select_fn: SelectFn = select_offers_missing_structured_data,
) -> list[str]:
    """Re-extracts every offer `select_fn` finds (the real
    `select_offers_missing_structured_data`, an unscoped table-wide query, by
    default), via `extract_fn` (the real `extract_job_offer` by default) so
    no extraction logic is duplicated here. An offer that still can't
    resolve structuredData (or has no stored raw content to re-extract from)
    is logged and skipped rather than aborting the rest of the batch.
    Returns the ids that were successfully repaired.

    `select_fn` is overridable so tests exercising the extract/skip
    delegation logic can scope this to their own fixture rows instead of the
    real table-wide query -- that query intersecting real data mid-test once
    caused a broad, real data-corrupting run of a test's fake `extract_fn`
    stub against production-like rows in the shared dev DB.
    """
    offers = await select_fn(session)
    repaired: list[str] = []
    for offer in offers:
        try:
            await extract_fn(session, offer.id)
        except ExtractionError:
            logger.warning(
                "repair_missing_structured_data_offers.skip",
                extra={"fields": {"job_offer_id": offer.id}},
            )
            continue
        repaired.append(offer.id)
    return repaired


async def _main() -> None:
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            repaired_ids = await repair_missing_structured_data_offers(session)
        logger.info(
            "repair_missing_structured_data_offers.done",
            extra={
                "fields": {
                    "repaired_count": len(repaired_ids),
                    "repaired_ids": repaired_ids,
                }
            },
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_main())
