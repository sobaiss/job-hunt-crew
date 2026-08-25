import uuid
from datetime import UTC, datetime

import httpx
from analysis.job_offer_extraction_agent import ExtractionError, extract_job_offer
from analysis.llm_provider import LLMProvider
from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .scrape import ScrapeError, scrape_job_offer


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def dedupe_and_cap_urls(urls: list[str], max_offers: int) -> list[str]:
    """Dedupes discovered offer URLs (order-preserving) and caps the result
    at `max_offers` (PRD 8.4 step 2/3: "Deduplicates URLs, caps total at
    IngestionJob.maxOffers (default 25)").
    """
    seen: set[str] = set()
    deduped: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            deduped.append(url)
    return deduped[:max_offers]


async def link_discovered_offers(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    urls: list[str],
) -> list[JobOffer]:
    """Dedupes+caps `urls` at `ingestion_job.maxOffers` (M3-T3), then for
    each retained URL gets-or-creates a globally-deduplicated JobOffer (by
    sourceUrl, PRD Section 6 dedup design decision) and links it to
    `ingestion_job` via an IngestionJobOffer join row. Does not run the
    scrape/extraction pipeline against the linked offers — `process_job_offer`
    / `link_and_process_offers` (M3-T4) build on this retained set.
    """
    retained_urls = dedupe_and_cap_urls(urls, ingestion_job.maxOffers)

    job_offers: list[JobOffer] = []
    for url in retained_urls:
        job_offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == url))
        if job_offer is None:
            job_offer = JobOffer(
                id=str(uuid.uuid4()),
                sourceUrl=url,
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.PENDING,
                updatedAt=_now(),
            )
            session.add(job_offer)
            await session.flush()
        job_offers.append(job_offer)

        existing_link = await session.scalar(
            select(IngestionJobOffer).where(
                IngestionJobOffer.ingestionJobId == ingestion_job.id,
                IngestionJobOffer.jobOfferId == job_offer.id,
            )
        )
        if existing_link is None:
            session.add(
                IngestionJobOffer(
                    id=str(uuid.uuid4()),
                    ingestionJobId=ingestion_job.id,
                    jobOfferId=job_offer.id,
                )
            )

    await session.commit()
    return job_offers


async def process_job_offer(
    session: AsyncSession,
    job_offer: JobOffer,
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
    ingestion_job_id: str | None = None,
) -> JobOffer:
    """Runs the Mode 1 pipeline (M2-T2 scrape, M2-T4 extraction) for a single
    linked JobOffer. A no-op for an offer that's already reached a terminal
    extractionStatus (READY/FAILED) — since JobOffer is globally deduplicated
    by sourceUrl (PRD Section 6), a listing fan-out may link an offer another
    ingestion already scraped/extracted, and PRD Section 6's dedup rationale
    ("avoid re-scraping/re-extracting the same posting for every user")
    applies here too. Scrape/extraction failures are caught (both steps
    already record FAILED + errorMessage on the row themselves) so one
    offer's failure doesn't abort the fan-out for the rest — aggregating
    per-job scraped/failed counts is M3-T5's scope. `ingestion_job_id` tags
    the scrape/extract PipelineEvent/log rows emitted along the way (M6-T3).
    """
    if job_offer.extractionStatus in (Jobofferextractionstatus.READY, Jobofferextractionstatus.FAILED):
        return job_offer

    try:
        await scrape_job_offer(
            session, job_offer.id, http_client=http_client, ingestion_job_id=ingestion_job_id
        )
    except ScrapeError:
        return await session.get(JobOffer, job_offer.id)

    try:
        await extract_job_offer(
            session, job_offer.id, llm_provider=llm_provider, ingestion_job_id=ingestion_job_id
        )
    except ExtractionError:
        pass

    return await session.get(JobOffer, job_offer.id)


async def link_and_process_offers(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    urls: list[str],
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
) -> list[JobOffer]:
    """PRD Section 8.4 step 4: for each retained URL, creates/links a
    JobOffer (via `link_discovered_offers`, M3-T3) and runs the Mode 1
    pipeline (M2-T2..T4) per offer, then rolls up the IngestionJob's
    aggregate counts/status (M3-T5, PRD Section 8.4 step 5).
    """
    job_offers = await link_discovered_offers(session, ingestion_job, urls)
    processed = [
        await process_job_offer(
            session,
            job_offer,
            http_client=http_client,
            llm_provider=llm_provider,
            ingestion_job_id=ingestion_job.id,
        )
        for job_offer in job_offers
    ]
    await update_ingestion_job_aggregate(session, ingestion_job.id)
    return processed


async def update_ingestion_job_aggregate(session: AsyncSession, ingestion_job_id: str) -> IngestionJob:
    """PRD Section 8.4 step 5: recomputes `discoveredCount`/`scrapedCount`/
    `failedCount` from the JobOffers currently linked to `ingestion_job_id`
    and rolls up `status`:
      - any linked offer still short of a terminal extractionStatus -> RUNNING
      - all terminal, none FAILED -> COMPLETED
      - all terminal, some (not all) FAILED -> PARTIALLY_COMPLETED
      - all terminal, all FAILED -> FAILED
    """
    linked_offers = (
        await session.scalars(
            select(JobOffer)
            .join(IngestionJobOffer, IngestionJobOffer.jobOfferId == JobOffer.id)
            .where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
        )
    ).all()

    discovered_count = len(linked_offers)
    scraped_count = sum(1 for offer in linked_offers if offer.extractionStatus == Jobofferextractionstatus.READY)
    failed_count = sum(1 for offer in linked_offers if offer.extractionStatus == Jobofferextractionstatus.FAILED)
    terminal_count = scraped_count + failed_count

    error_message: str | None = None
    if discovered_count == 0 or terminal_count < discovered_count:
        status = Ingestionjobstatus.RUNNING
    elif failed_count == 0:
        status = Ingestionjobstatus.COMPLETED
    elif failed_count == discovered_count:
        status = Ingestionjobstatus.FAILED
        error_message = f"All {discovered_count} discovered offers failed to scrape/extract"
    else:
        status = Ingestionjobstatus.PARTIALLY_COMPLETED
        error_message = f"{failed_count} of {discovered_count} discovered offers failed to scrape/extract"

    ingestion_job = await session.get(IngestionJob, ingestion_job_id)
    ingestion_job.discoveredCount = discovered_count
    ingestion_job.scrapedCount = scraped_count
    ingestion_job.failedCount = failed_count
    ingestion_job.status = status
    ingestion_job.errorMessage = error_message
    ingestion_job.updatedAt = _now()
    await session.commit()
    await session.refresh(ingestion_job)
    return ingestion_job
