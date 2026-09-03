"""SINGLE_URL ingestion entrypoint (issue #27) — the "Analyse one offer"
backbone. Parallel to `run_site_search_ingestion` (Mode 3): given an
`IngestionJob` carrying `inputUrl`, get-or-create the globally-deduplicated
`JobOffer` for that canonical URL, bring it to `READY` (reusing it untouched
if it already reached `READY`, retrying it if it previously `FAILED`), link
it to the job and roll up the job's aggregate counts/status.

The `inputUrl`'s host is matched against the enabled `SiteConfig` rows
(`baseUrl` or `apiBaseUrl`). An OFFICIAL_API match (France Travail) is
fetched straight from that API into structured data, skipping the scrape +
LLM-extraction pipeline — the same shortcut `run_site_search_ingestion`
takes. Everything else runs the Mode 1 scrape + extraction.

If the fetched page looks like a job listing / search-results page rather
than a single offer, the job is failed with `LISTING_PAGE_ERROR_MESSAGE` — a
distinguishable reason the "Analyse one offer" screen maps to a "looks like a
listing" redirect (issue #31), distinct from a generic fetch/extract failure.

The end-of-fan-out Analysis-creation step (one `Analysis` per `READY`
`JobOffer`, `analysis-intake` enqueue, daily-cap handling) lives in
`analysis_fanout.py`, not here.
"""

import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

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
    SiteConfig,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .fanout import update_ingestion_job_aggregate
from .france_travail import FranceTravailApiError, ingest_france_travail_single_offer
from .listing import looks_like_listing
from .s3_client import S3_BUCKET, make_s3_client
from .scrape import ScrapeError, scrape_job_offer
from .site_search import extract_offer_id

# Distinguishable `IngestionJob.errorMessage` for a SINGLE_URL request whose
# page turned out to be a listing (issue #31). The machine-readable prefix
# lets the web layer tell it apart from a generic scrape/extract failure.
LISTING_PAGE_ERROR_MESSAGE = (
    "LISTING_PAGE_DETECTED: the fetched page looks like a job listing / "
    "search-results page, not a single offer"
)

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


def _host_matches(target: str, base_url: str | None) -> bool:
    base = _host(base_url or "")
    return bool(base) and (target == base or target.endswith(f".{base}"))


async def _match_site_config(session: AsyncSession, url: str) -> SiteConfig | None:
    """The enabled `SiteConfig` whose `baseUrl` *or* `apiBaseUrl` host matches
    `url`'s host (exact or subdomain), or `None` when nothing matches (PRD
    Section 8.3 step 3). `apiBaseUrl` is matched too so a pasted OFFICIAL_API
    URL (`api.francetravail.io/...`, a different host than the site's
    `baseUrl`) still resolves to its site.
    """
    target = _host(url)
    if not target:
        return None

    configs = (await session.scalars(select(SiteConfig).where(SiteConfig.enabled.is_(True)))).all()
    for config in configs:
        if _host_matches(target, config.baseUrl) or _host_matches(target, config.apiBaseUrl):
            return config
    return None


def _source_site_for(site_config: SiteConfig | None) -> Joboffersourcesite:
    if site_config is None:
        return Joboffersourcesite.OTHER
    return _SITE_KEY_TO_SOURCE_SITE.get(site_config.siteKey, Joboffersourcesite.OTHER)


async def _fail(session: AsyncSession, ingestion_job: IngestionJob, message: str) -> IngestionJob:
    ingestion_job.status = Ingestionjobstatus.FAILED
    ingestion_job.errorMessage = message
    ingestion_job.updatedAt = _now()
    await session.commit()
    await session.refresh(ingestion_job)
    return ingestion_job


def _read_scraped_html(raw_content_key: str) -> str:
    obj = make_s3_client().get_object(Bucket=S3_BUCKET, Key=raw_content_key)
    return obj["Body"].read().decode("utf-8")


async def run_single_url_ingestion(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
) -> IngestionJob:
    """PRD Section 8.3. Get-or-creates the `JobOffer` for
    `ingestion_job.inputUrl` (deduped globally by `sourceUrl`), links it to
    the job, brings it to `READY` (a no-op for an already-`READY` offer, a
    retry for a previously-`FAILED` one) and rolls up the job's
    `discoveredCount` / `scrapedCount` / `failedCount` / `status` through
    `update_ingestion_job_aggregate`.

    An `inputUrl` that resolves to an OFFICIAL_API site (France Travail) is
    fetched straight from that API into structured data
    (`ingest_france_travail_single_offer`) -- no HTML scrape / LLM extraction.
    Otherwise the Mode 1 scrape + extraction runs, and between the two the
    fetched HTML is checked with `looks_like_listing`: a pasted search-results
    / listing page fails the job with `LISTING_PAGE_ERROR_MESSAGE` (issue #31)
    and is never extracted.
    """
    url = (ingestion_job.inputUrl or "").strip()
    if not url:
        return await _fail(session, ingestion_job, "SINGLE_URL ingestion job has no inputUrl")

    site_config = await _match_site_config(session, url)

    job_offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == url))
    if job_offer is None:
        job_offer = JobOffer(
            id=str(uuid.uuid4()),
            sourceUrl=url,
            sourceSite=_source_site_for(site_config),
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

    # Already-terminal offer (a prior ingestion left it READY): reuse it
    # untouched, exactly as `process_job_offer` would (PRD Section 6 dedup).
    if job_offer.extractionStatus == Jobofferextractionstatus.READY:
        await update_ingestion_job_aggregate(session, ingestion_job.id)
        return await session.get(IngestionJob, ingestion_job.id)

    # OFFICIAL_API site (France Travail): the API returns structured data, so
    # fetch the offer directly and skip scrape + LLM extraction entirely.
    if site_config is not None and site_config.integrationType == Siteconfigintegrationtype.OFFICIAL_API:
        offer_id = extract_offer_id(site_config, url)
        if not offer_id:
            job_offer.extractionStatus = Jobofferextractionstatus.FAILED
            job_offer.errorMessage = (
                f"Could not determine a {site_config.siteKey.value} offer id from {url}"
            )
            job_offer.updatedAt = _now()
            await session.commit()
            await update_ingestion_job_aggregate(session, ingestion_job.id)
            return await session.get(IngestionJob, ingestion_job.id)

        try:
            await ingest_france_travail_single_offer(
                session, ingestion_job, site_config, job_offer, offer_id, http_client=http_client
            )
        except FranceTravailApiError:
            # The offer is already FAILED + errorMessage'd by the call above;
            # let the rollup mark the job, exactly as the ScrapeError path does.
            pass
        await update_ingestion_job_aggregate(session, ingestion_job.id)
        return await session.get(IngestionJob, ingestion_job.id)

    # HTML_SCRAPE site (or no matching SiteConfig): Mode 1 scrape + extraction.
    try:
        await scrape_job_offer(
            session, job_offer.id, http_client=http_client, ingestion_job_id=ingestion_job.id
        )
    except ScrapeError:
        await update_ingestion_job_aggregate(session, ingestion_job.id)
        return await session.get(IngestionJob, ingestion_job.id)

    job_offer = await session.get(JobOffer, job_offer.id)
    if looks_like_listing(_read_scraped_html(job_offer.rawContentKey), job_offer.sourceUrl):
        job_offer.extractionStatus = Jobofferextractionstatus.FAILED
        job_offer.errorMessage = LISTING_PAGE_ERROR_MESSAGE
        job_offer.updatedAt = _now()
        await session.commit()
        await update_ingestion_job_aggregate(session, ingestion_job.id)
        return await _fail(session, ingestion_job, LISTING_PAGE_ERROR_MESSAGE)

    try:
        await extract_job_offer(
            session, job_offer.id, llm_provider=llm_provider, ingestion_job_id=ingestion_job.id
        )
    except ExtractionError:
        pass

    await update_ingestion_job_aggregate(session, ingestion_job.id)
    return await session.get(IngestionJob, ingestion_job.id)
