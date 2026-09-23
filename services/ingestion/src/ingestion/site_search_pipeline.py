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
from py_db.models import (
    IngestionJob,
    Ingestionjobstatus,
    SiteConfig,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)
from sqlalchemy.ext.asyncio import AsyncSession

from .api_ingest import link_api_offers
from .api_sources import (
    JobApiError,
    filter_by_posted_within,
    get_source,
    missing_credentials,
)
from .fanout import link_and_process_offers
from .france_travail import ingest_france_travail_offers
from .listing import ListingFetchError, fetch_listing_pages
from .site_adapters import SiteAdapterConfigError, extract_offer_urls_via_site_config
from .site_search import SiteSearchConfigError, build_search_url


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def _fail(
    session: AsyncSession, ingestion_job: IngestionJob, message: str
) -> IngestionJob:
    ingestion_job.status = Ingestionjobstatus.FAILED
    ingestion_job.errorMessage = message
    ingestion_job.updatedAt = _now()
    await session.commit()
    await session.refresh(ingestion_job)
    return ingestion_job


async def _run_api_source_ingestion(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
) -> None:
    """The OFFICIAL_API path for every source in `api_sources.SOURCES` —
    everything except France Travail, whose OAuth2 flow keeps its own module.

    Holds the same step-5 failure contract as the HTML_SCRAPE path: a
    missing credential or a failed call marks the IngestionJob FAILED with a
    clear errorMessage, never a silent zero-result return.
    """
    source = get_source(site_config.siteKey)
    if source is None:
        await _fail(
            session,
            ingestion_job,
            f"{site_config.siteKey.value} is configured as OFFICIAL_API but has no "
            "adapter in ingestion.api_sources",
        )
        return

    if missing := missing_credentials(site_config.siteKey):
        await _fail(
            session,
            ingestion_job,
            f"{site_config.siteKey.value} is enabled but not configured: set "
            f"{', '.join(missing)}",
        )
        return

    try:
        offers = await source.search(
            site_config,
            filters,
            http_client=http_client,
            limit=ingestion_job.maxOffers,
        )
    except JobApiError as exc:
        await _fail(session, ingestion_job, str(exc))
        return

    # Sources whose API has no date parameter (Remotive) get the window
    # applied here instead; it's a no-op for one that already filtered.
    offers = filter_by_posted_within(offers, filters.get("postedWithin"))

    if not offers:
        await _fail(
            session,
            ingestion_job,
            f"No offers returned by {site_config.siteKey.value} for these filters",
        )
        return

    await link_api_offers(
        session, ingestion_job, offers, source_site=source.source_site
    )


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
        if site_config.siteKey == Siteconfigsitekey.FRANCE_TRAVAIL:
            await ingest_france_travail_offers(
                session, ingestion_job, site_config, filters, http_client=http_client
            )
        else:
            await _run_api_source_ingestion(
                session, ingestion_job, site_config, filters, http_client=http_client
            )
        return await session.get(IngestionJob, ingestion_job.id)

    try:
        search_url = build_search_url(site_config, filters)
    except SiteSearchConfigError as exc:
        return await _fail(
            session,
            ingestion_job,
            f"Failed to build search URL for {site_config.siteKey}: {exc}",
        )

    try:
        pages = await fetch_listing_pages(
            search_url, http_client=http_client, site_config=site_config
        )
    except ListingFetchError as exc:
        # A detected block already names the site's own mechanism ("BLOCKED_
        # CAPTCHA: ...") — prefixing it with "Failed to fetch listing" would
        # bury the one part of the message an operator acts on.
        message = (
            f"{site_config.siteKey.value}: {exc}"
            if exc.detection is not None
            else f"Failed to fetch listing for {site_config.siteKey}: {exc}"
        )
        return await _fail(session, ingestion_job, message)

    try:
        seen: set[str] = set()
        urls: list[str] = []
        for page_html in pages:
            for url in extract_offer_urls_via_site_config(
                page_html, search_url, site_config
            ):
                if url not in seen:
                    seen.add(url)
                    urls.append(url)
    except SiteAdapterConfigError as exc:
        return await _fail(
            session,
            ingestion_job,
            f"Adapter configuration error for {site_config.siteKey}: {exc}",
        )

    if not urls:
        # Reaching here now means something specific: the listing fetch
        # succeeded *and* `blocking.detect_block` found no interstitial, so
        # this is real page content the selectors didn't match — selector
        # drift (PRD Section 14), not a block. The old message hedged between
        # the two because the pipeline couldn't tell them apart.
        return await _fail(
            session,
            ingestion_job,
            f"No offers found for {site_config.siteKey.value}: the listing page was "
            f"fetched successfully and is not an anti-bot page, so "
            f"listItemSelector ({site_config.listItemSelector!r}) / offerLinkSelector "
            f"({site_config.offerLinkSelector!r}) no longer match its markup",
        )

    await link_and_process_offers(
        session, ingestion_job, urls, http_client=http_client, llm_provider=llm_provider
    )
    return await session.get(IngestionJob, ingestion_job.id)
