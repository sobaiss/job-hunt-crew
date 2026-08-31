"""SINGLE_URL ingestion entrypoint (issue #27) — the "Analyse one offer"
backbone. Parallel to `run_site_search_ingestion` (Mode 3): given an
`IngestionJob` carrying `inputUrl`, get-or-create the globally-deduplicated
`JobOffer` for that canonical URL, run the Mode 1 scrape + extraction
pipeline against it (reusing it untouched if it already reached `READY`,
retrying it if it previously `FAILED`), link it to the job and roll up the
job's aggregate counts/status.

The end-of-fan-out Analysis-creation step (one `Analysis` per `READY`
`JobOffer`, `analysis-intake` enqueue, daily-cap handling) and listing-page
detection are the remaining halves of #27 and are not done here.
"""

import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx
from analysis.llm_provider import LLMProvider
from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    SiteConfig,
    Siteconfigsitekey,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .fanout import process_job_offer, update_ingestion_job_aggregate

# SiteConfig.siteKey -> JobOffer.sourceSite. Every HTML_SCRAPE / OFFICIAL_API
# site we seed has a matching sourceSite; anything else falls back to OTHER.
_SITE_KEY_TO_SOURCE_SITE = {
    Siteconfigsitekey.LINKEDIN: Joboffersourcesite.LINKEDIN,
    Siteconfigsitekey.INDEED: Joboffersourcesite.INDEED,
    Siteconfigsitekey.FRANCE_TRAVAIL: Joboffersourcesite.FRANCE_TRAVAIL,
    Siteconfigsitekey.WTTJ: Joboffersourcesite.WTTJ,
    Siteconfigsitekey.GLASSDOOR: Joboffersourcesite.GLASSDOOR,
}


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _host(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


async def _match_source_site(session: AsyncSession, url: str) -> Joboffersourcesite:
    """Matches `url`'s host against the enabled `SiteConfig` rows' `baseUrl`
    host (exact or subdomain), returning the corresponding `sourceSite` or
    `OTHER` when nothing matches (PRD Section 8.3 step 3).
    """
    target = _host(url)
    if not target:
        return Joboffersourcesite.OTHER

    configs = (await session.scalars(select(SiteConfig).where(SiteConfig.enabled.is_(True)))).all()
    for config in configs:
        base = _host(config.baseUrl)
        if base and (target == base or target.endswith(f".{base}")):
            return _SITE_KEY_TO_SOURCE_SITE.get(config.siteKey, Joboffersourcesite.OTHER)
    return Joboffersourcesite.OTHER


async def _fail(session: AsyncSession, ingestion_job: IngestionJob, message: str) -> IngestionJob:
    ingestion_job.status = Ingestionjobstatus.FAILED
    ingestion_job.errorMessage = message
    ingestion_job.updatedAt = _now()
    await session.commit()
    await session.refresh(ingestion_job)
    return ingestion_job


async def run_single_url_ingestion(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
) -> IngestionJob:
    """PRD Section 8.3. Get-or-creates the `JobOffer` for
    `ingestion_job.inputUrl` (deduped globally by `sourceUrl`), links it to
    the job, runs the Mode 1 pipeline against it via `process_job_offer`
    (a no-op for an already-`READY` offer, a retry for a previously-`FAILED`
    one) and rolls up the job's `discoveredCount` / `scrapedCount` /
    `failedCount` / `status` through `update_ingestion_job_aggregate`.
    """
    url = (ingestion_job.inputUrl or "").strip()
    if not url:
        return await _fail(session, ingestion_job, "SINGLE_URL ingestion job has no inputUrl")

    job_offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == url))
    if job_offer is None:
        job_offer = JobOffer(
            id=str(uuid.uuid4()),
            sourceUrl=url,
            sourceSite=await _match_source_site(session, url),
            extractionStatus=Jobofferextractionstatus.PENDING,
            updatedAt=_now(),
        )
        session.add(job_offer)
        await session.flush()
    elif job_offer.extractionStatus == Jobofferextractionstatus.FAILED:
        # A previous ingestion left this offer FAILED — retry it (PRD Section
        # 8.3: a transient fetch failure must not be permanent). Reset it to
        # PENDING so `process_job_offer` doesn't short-circuit on it.
        job_offer.extractionStatus = Jobofferextractionstatus.PENDING
        job_offer.errorMessage = None
        job_offer.updatedAt = _now()
        await session.flush()

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

    await process_job_offer(
        session,
        job_offer,
        http_client=http_client,
        llm_provider=llm_provider,
        ingestion_job_id=ingestion_job.id,
    )
    await update_ingestion_job_aggregate(session, ingestion_job.id)
    return await session.get(IngestionJob, ingestion_job.id)
