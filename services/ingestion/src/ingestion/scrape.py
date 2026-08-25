from datetime import UTC, datetime

import httpx
from py_db.models import JobOffer, Jobofferextractionstatus
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from sqlalchemy.ext.asyncio import AsyncSession

from .s3_client import S3_BUCKET, make_s3_client, raw_scrape_key

logger = get_logger(__name__)

STAGE = "scrape"


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
    ingestion_job_id: str | None = None,
) -> JobOffer:
    """Generic single-URL scrape step (PRD 8.3 steps 2/4 fallback path, no
    SiteConfig adapter yet). Fetches JobOffer.sourceUrl, stores the raw HTML
    at raw-scrapes/{jobOfferId}.html in S3, and transitions
    extractionStatus PENDING -> SCRAPING -> SCRAPED. On fetch failure,
    transitions to FAILED with errorMessage set instead. `ingestion_job_id`
    is optional context (a JobOffer may be scraped standalone, e.g. Mode 1)
    used only to tag the PipelineEvent/log rows this emits (M6-T3).
    """
    job_offer = await session.get(JobOffer, job_offer_id)
    if job_offer is None:
        raise ScrapeError(f"JobOffer {job_offer_id} not found")

    log_stage_event(
        logger, stage=STAGE, status="STARTED", job_offer_id=job_offer_id, ingestion_job_id=ingestion_job_id
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="STARTED",
        message=f"job_offer_id={job_offer_id}",
        ingestion_job_id=ingestion_job_id,
    )

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
            log_stage_event(
                logger,
                stage=STAGE,
                status="FAILED",
                job_offer_id=job_offer_id,
                ingestion_job_id=ingestion_job_id,
                message=job_offer.errorMessage,
            )
            await record_pipeline_event(
                session,
                stage=STAGE,
                status="FAILED",
                message=f"job_offer_id={job_offer_id}: {job_offer.errorMessage}",
                ingestion_job_id=ingestion_job_id,
            )
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

    log_stage_event(
        logger, stage=STAGE, status="SUCCEEDED", job_offer_id=job_offer_id, ingestion_job_id=ingestion_job_id
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="SUCCEEDED",
        message=f"job_offer_id={job_offer_id}",
        ingestion_job_id=ingestion_job_id,
    )
    return job_offer
