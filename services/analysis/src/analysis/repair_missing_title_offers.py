"""One-off repair task (issue #119) for JobOffer rows scraped before #115's
JSON-LD/LLM title extraction landed, so they're stuck with a missing title
despite already having raw page content stored in S3. Re-runs extraction
(`extract_job_offer`) against that stored content -- no re-scraping needed.

Deliberately manual: nothing schedules or triggers this automatically. Run
it once via `python -m analysis.repair_missing_title_offers` against the
target environment's DATABASE_URL.
"""

import asyncio
from collections.abc import Awaitable, Callable

from py_db.models import JobOffer, Joboffersourcesite
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .job_offer_extraction_agent import ExtractionError, extract_job_offer

logger = get_logger(__name__)

ExtractFn = Callable[[AsyncSession, str], Awaitable[JobOffer]]


async def select_offers_missing_title(session: AsyncSession) -> list[JobOffer]:
    """Offers from scraping-based sites (never France-Travail, whose data
    comes from its own official API and is already authoritative) that have
    raw content stored but no title -- the population #115's two-tier
    extraction fix should be re-run against.
    """
    result = await session.scalars(
        select(JobOffer).where(
            JobOffer.sourceSite != Joboffersourcesite.FRANCE_TRAVAIL,
            JobOffer.rawContentKey.is_not(None),
            or_(JobOffer.title.is_(None), JobOffer.title == ""),
        )
    )
    return list(result.all())


async def repair_missing_title_offers(
    session: AsyncSession, *, extract_fn: ExtractFn = extract_job_offer
) -> list[str]:
    """Re-extracts every offer `select_offers_missing_title` finds, via
    `extract_fn` (the real `extract_job_offer` by default) so no extraction
    logic is duplicated here. An offer whose title is still unresolvable is
    logged and skipped rather than aborting the rest of the batch. Returns
    the ids that were successfully repaired.
    """
    offers = await select_offers_missing_title(session)
    repaired: list[str] = []
    for offer in offers:
        try:
            await extract_fn(session, offer.id)
        except ExtractionError:
            logger.warning(
                "repair_missing_title_offers.skip", extra={"fields": {"job_offer_id": offer.id}}
            )
            continue
        repaired.append(offer.id)
    return repaired


async def _main() -> None:
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            repaired_ids = await repair_missing_title_offers(session)
        logger.info(
            "repair_missing_title_offers.done",
            extra={"fields": {"repaired_count": len(repaired_ids), "repaired_ids": repaired_ids}},
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(_main())
