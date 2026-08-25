import uuid
from datetime import UTC, datetime

from py_db.models import IngestionJob, IngestionJobOffer, JobOffer, Jobofferextractionstatus, Joboffersourcesite
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


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
    scrape/extraction pipeline against the linked offers — that fan-out
    (M3-T4) reuses this retained set.
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
