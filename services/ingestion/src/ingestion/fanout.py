import uuid
from datetime import UTC, datetime

import httpx
from analysis.job_offer_extraction_agent import ExtractionError, extract_job_offer
from analysis.llm_provider import LLMProvider
from bs4 import BeautifulSoup
from py_db.models import (
    CVVersion,
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
)
from py_db.scout_matching import analyses_created_for_scout_run, lexical_similarity, scout_max_analyses_per_run
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .s3_client import S3_BUCKET, make_s3_client
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


async def _scrape_step(
    session: AsyncSession,
    job_offer: JobOffer,
    *,
    http_client: httpx.AsyncClient | None = None,
    ingestion_job_id: str | None = None,
) -> JobOffer:
    """The scrape half of `process_job_offer`, split out so a Scout job's
    extraction ceiling (issue #55) can scrape every discovered offer before
    ranking which ones proceed to extraction."""
    if job_offer.extractionStatus in (Jobofferextractionstatus.READY, Jobofferextractionstatus.FAILED):
        return job_offer
    try:
        return await scrape_job_offer(
            session, job_offer.id, http_client=http_client, ingestion_job_id=ingestion_job_id
        )
    except ScrapeError:
        return await session.get(JobOffer, job_offer.id)


async def _extract_step(
    session: AsyncSession,
    job_offer: JobOffer,
    *,
    llm_provider: LLMProvider | None = None,
    ingestion_job_id: str | None = None,
) -> JobOffer:
    """The extraction half of `process_job_offer`, split out for the same
    reason as `_scrape_step`."""
    try:
        await extract_job_offer(
            session, job_offer.id, llm_provider=llm_provider, ingestion_job_id=ingestion_job_id
        )
    except ExtractionError:
        pass
    return await session.get(JobOffer, job_offer.id)


async def _raw_scrape_text(job_offer: JobOffer) -> str:
    """Plain text pulled from the raw scraped HTML (S3 `rawContentKey`), for
    the pre-extraction ceiling's lexical-similarity rank — the same raw HTML
    `extract_job_offer` would otherwise consume in full. Empty for an offer
    that never scraped (no `rawContentKey`)."""
    if not job_offer.rawContentKey:
        return ""
    s3 = make_s3_client()
    obj = s3.get_object(Bucket=S3_BUCKET, Key=job_offer.rawContentKey)
    html = obj["Body"].read().decode("utf-8")
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


async def _scrape_all_then_extract_within_ceiling(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    job_offers: list[JobOffer],
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
) -> list[JobOffer]:
    """Scout extraction ceiling (issue #55 follow-up): scrapes every offer
    (PRD 8.4's "scrape all"), then ranks the ones freshly `SCRAPED` (not
    already terminal from an earlier job/run) by lexical similarity between
    their raw scraped text and the Scout's base CV, and extracts only
    whatever remains of `SCOUT_MAX_ANALYSES_PER_RUN` across the whole run so
    far. Offers beyond that ceiling stay `SCRAPED` — never extracted, so no
    extraction-LLM call is spent on them — and are counted on
    `ingestion_job.extractionSkippedCount`.
    """
    scraped = [
        await _scrape_step(session, job_offer, http_client=http_client, ingestion_job_id=ingestion_job.id)
        for job_offer in job_offers
    ]

    candidates = [offer for offer in scraped if offer.extractionStatus == Jobofferextractionstatus.SCRAPED]
    cv_version = await session.get(CVVersion, ingestion_job.cvVersionId)
    cv_text = cv_version.markdownContent if cv_version is not None else None
    texts = {offer.id: await _raw_scrape_text(offer) for offer in candidates}

    ranked_ids = sorted(
        (offer.id for offer in candidates),
        key=lambda oid: -lexical_similarity(texts[oid], cv_text),
    )
    budget = max(
        scout_max_analyses_per_run() - await analyses_created_for_scout_run(session, ingestion_job.scoutRunId),
        0,
    )
    to_extract_ids = set(ranked_ids[:budget])
    skipped_count = len(ranked_ids) - len(to_extract_ids)

    if skipped_count:
        ingestion_job.extractionSkippedCount = (ingestion_job.extractionSkippedCount or 0) + skipped_count
        ingestion_job.updatedAt = _now()
        await session.commit()

    processed: list[JobOffer] = []
    for offer in scraped:
        if offer.id in to_extract_ids:
            offer = await _extract_step(
                session, offer, llm_provider=llm_provider, ingestion_job_id=ingestion_job.id
            )
        processed.append(offer)
    return processed


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

    A Scout job (`ingestion_job.scoutRunId` and `.cvVersionId` both set)
    instead scrapes all offers and extracts only the pre-ranked top slice of
    the run's remaining ceiling (issue #55 follow-up,
    `_scrape_all_then_extract_within_ceiling`); a manual job keeps the
    original scrape-then-extract-every-offer behaviour byte-for-byte.
    """
    job_offers = await link_discovered_offers(session, ingestion_job, urls)
    if ingestion_job.scoutRunId and ingestion_job.cvVersionId:
        processed = await _scrape_all_then_extract_within_ceiling(
            session, ingestion_job, job_offers, http_client=http_client, llm_provider=llm_provider
        )
    else:
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

    A Scout job's extraction ceiling (issue #55 follow-up) deliberately
    leaves some offers at `SCRAPED` rather than extracting them — that's a
    terminal outcome for this job's rollup (a cost-bound choice, not a
    still-in-progress offer), so it counts toward `terminal_count` for a
    Scout job only; a manual job never leaves an offer at `SCRAPED` once its
    pipeline call returns, so this has no effect there.
    """
    ingestion_job = await session.get(IngestionJob, ingestion_job_id)

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
    ceiling_skipped_count = (
        sum(1 for offer in linked_offers if offer.extractionStatus == Jobofferextractionstatus.SCRAPED)
        if ingestion_job.scoutRunId
        else 0
    )
    terminal_count = scraped_count + failed_count + ceiling_skipped_count

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

    ingestion_job.discoveredCount = discovered_count
    ingestion_job.scrapedCount = scraped_count
    ingestion_job.failedCount = failed_count
    ingestion_job.status = status
    ingestion_job.errorMessage = error_message
    ingestion_job.updatedAt = _now()
    await session.commit()
    await session.refresh(ingestion_job)
    return ingestion_job
