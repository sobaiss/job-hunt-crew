"""Mode 3 (Preconfigured Site + Filters) per-site orchestration — PRD Section
8.5 steps 3-5. Ties together the URL/query builder (M4-T3), the France
Travail OFFICIAL_API path (M4-T4) and the HTML_SCRAPE listing fetch +
selector adapters (M3-T1, M4-T5) into a single entrypoint, and is
responsible for step 5's failure contract: "Per-site failure (e.g. LinkedIn
blocking the request) marks the IngestionJob FAILED/PARTIALLY_COMPLETED with
a clear errorMessage — never a silent zero-result return."
"""

from datetime import UTC, datetime

import httpx
from analysis.llm_provider import LLMProvider
from py_db.models import IngestionJob, Ingestionjobstatus, SiteConfig, Siteconfigintegrationtype
from sqlalchemy.ext.asyncio import AsyncSession

from .fanout import link_and_process_offers
from .france_travail import ingest_france_travail_offers
from .listing import ListingFetchError, fetch_listing_pages
from .site_adapters import SiteAdapterConfigError, extract_offer_urls_via_site_config
from .site_search import SiteSearchConfigError, build_search_url


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def _fail(session: AsyncSession, ingestion_job: IngestionJob, message: str) -> IngestionJob:
    ingestion_job.status = Ingestionjobstatus.FAILED
    ingestion_job.errorMessage = message
    ingestion_job.updatedAt = _now()
    await session.commit()
    await session.refresh(ingestion_job)
    return ingestion_job


async def run_site_search_ingestion(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
) -> IngestionJob:
    """PRD Section 8.5 steps 3-5. For OFFICIAL_API sites (France Travail),
    delegates straight to `ingest_france_travail_offers` (M4-T4). For
    HTML_SCRAPE sites, builds the search URL (M4-T3), fetches the listing
    pages (M3-T1), extracts offer URLs via the site's selectors (M4-T5) and
    fans out into the Mode 1/2 pipeline (M3-T4/T5). Any failure along this
    path — a misconfigured SiteConfig, a blocked/failed fetch, or selectors
    that discover zero offers (e.g. an anti-bot block page that doesn't
    match the expected structure, PRD Section 14) — marks the IngestionJob
    FAILED with a clear, non-empty errorMessage rather than leaving it stuck
    or silently reporting zero results as success.
    """
    if site_config.integrationType == Siteconfigintegrationtype.OFFICIAL_API:
        await ingest_france_travail_offers(session, ingestion_job, site_config, filters, http_client=http_client)
        return await session.get(IngestionJob, ingestion_job.id)

    try:
        search_url = build_search_url(site_config, filters)
    except SiteSearchConfigError as exc:
        return await _fail(session, ingestion_job, f"Failed to build search URL for {site_config.siteKey}: {exc}")

    try:
        pages = await fetch_listing_pages(search_url, http_client=http_client)
    except ListingFetchError as exc:
        return await _fail(session, ingestion_job, f"Failed to fetch listing for {site_config.siteKey}: {exc}")

    try:
        seen: set[str] = set()
        urls: list[str] = []
        for page_html in pages:
            for url in extract_offer_urls_via_site_config(page_html, search_url, site_config):
                if url not in seen:
                    seen.add(url)
                    urls.append(url)
    except SiteAdapterConfigError as exc:
        return await _fail(
            session, ingestion_job, f"Adapter configuration error for {site_config.siteKey}: {exc}"
        )

    if not urls:
        return await _fail(
            session,
            ingestion_job,
            f"No offers found for {site_config.siteKey}; the site may be blocking requests "
            "or its HTML structure may have changed",
        )

    await link_and_process_offers(session, ingestion_job, urls, http_client=http_client, llm_provider=llm_provider)
    return await session.get(IngestionJob, ingestion_job.id)
