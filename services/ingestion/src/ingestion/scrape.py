from datetime import UTC, datetime

import httpx
from py_db.models import JobOffer, Jobofferextractionstatus
from sqlalchemy.ext.asyncio import AsyncSession

from .s3_client import S3_BUCKET, make_s3_client, raw_scrape_key


class ScrapeError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def scrape_job_offer(
    session: AsyncSession,
    job_offer_id: str,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> JobOffer:
    """Generic single-URL scrape step (PRD 8.3 steps 2/4 fallback path, no
    SiteConfig adapter yet). Fetches JobOffer.sourceUrl, stores the raw HTML
    at raw-scrapes/{jobOfferId}.html in S3, and transitions
    extractionStatus PENDING -> SCRAPING -> SCRAPED. On fetch failure,
    transitions to FAILED with errorMessage set instead.
    """
    job_offer = await session.get(JobOffer, job_offer_id)
    if job_offer is None:
        raise ScrapeError(f"JobOffer {job_offer_id} not found")

    job_offer.extractionStatus = Jobofferextractionstatus.SCRAPING
    job_offer.updatedAt = _now()
    await session.commit()

    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(follow_redirects=True, timeout=30.0)
    try:
        try:
            response = await client.get(job_offer.sourceUrl)
            response.raise_for_status()
            html = response.text
        except httpx.HTTPError as exc:
            job_offer.extractionStatus = Jobofferextractionstatus.FAILED
            job_offer.errorMessage = f"Failed to fetch {job_offer.sourceUrl}: {exc}"
            job_offer.updatedAt = _now()
            await session.commit()
            raise ScrapeError(job_offer.errorMessage) from exc
    finally:
        if owns_client:
            await client.aclose()

    key = raw_scrape_key(job_offer_id)
    s3 = make_s3_client()
    s3.put_object(Bucket=S3_BUCKET, Key=key, Body=html.encode("utf-8"), ContentType="text/html")

    job_offer.rawContentKey = key
    job_offer.extractionStatus = Jobofferextractionstatus.SCRAPED
    job_offer.updatedAt = _now()
    await session.commit()
    return job_offer
