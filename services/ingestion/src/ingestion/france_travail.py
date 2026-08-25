"""France Travail OFFICIAL_API integration (PRD Section 8.5 step 3 /
Section 14: "France Travail uses its official public API
(francetravail.io), integrationType=OFFICIAL_API, not HTML scraping.").

Unlike the HTML_SCRAPE sites, the API already returns structured offer
data, so this bypasses the generic Mode 1/2 scrape+LLM-extraction pipeline
entirely: JobOffers created from a France Travail search go straight to
extractionStatus=READY with structuredData populated from the API
response.
"""

import os
import uuid
from datetime import UTC, datetime

import httpx
from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    SiteConfig,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .fanout import dedupe_and_cap_urls, update_ingestion_job_aggregate
from .site_search import build_search_url

TOKEN_URL = "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire"
DEFAULT_SCOPE = "api_offresdemploiv2 o2dsoffre"
SEARCH_PATH = "/offres/search"


class FranceTravailApiError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def _get_access_token(client: httpx.AsyncClient) -> str:
    client_id = os.environ.get("FRANCE_TRAVAIL_CLIENT_ID")
    client_secret = os.environ.get("FRANCE_TRAVAIL_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise FranceTravailApiError(
            "FRANCE_TRAVAIL_CLIENT_ID and FRANCE_TRAVAIL_CLIENT_SECRET must be set"
        )
    try:
        response = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
                "scope": os.environ.get("FRANCE_TRAVAIL_SCOPE", DEFAULT_SCOPE),
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise FranceTravailApiError(f"Failed to obtain France Travail access token: {exc}") from exc
    token = response.json().get("access_token")
    if not token:
        raise FranceTravailApiError("France Travail token response missing access_token")
    return token


def _build_search_url(site_config: SiteConfig, filters: dict[str, str]) -> str:
    base = build_search_url(site_config, filters)
    root, _, query = base.partition("?")
    return f"{root}{SEARCH_PATH}?{query}" if query else f"{root}{SEARCH_PATH}"


def _offer_source_url(offre: dict) -> str:
    url_origine = (offre.get("origineOffre") or {}).get("urlOrigine")
    if url_origine:
        return url_origine
    return f"https://candidat.francetravail.fr/offres/recherche/detail/{offre['id']}"


def _offer_posted_at(offre: dict) -> datetime | None:
    raw = offre.get("dateCreation")
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).replace(tzinfo=None)


def _offer_structured_data(offre: dict) -> dict:
    return {
        "description": offre.get("description"),
        "requirements": [c.get("libelle") for c in offre.get("competences", []) if c.get("libelle")],
        "salary": (offre.get("salaire") or {}).get("libelle"),
        "contractType": offre.get("typeContratLibelle") or offre.get("typeContrat"),
        "remotePolicy": None,
        "seniority": offre.get("experienceLibelle"),
    }


async def search_offers(
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
) -> list[dict]:
    """Authenticates via OAuth2 client-credentials and calls the France
    Travail "Offres d'emploi v2" search endpoint, returning the raw
    `resultats` list from the response (PRD 8.5 step 3: "Backend builds the
    target URL/API call from SiteConfig.searchUrlTemplate +
    filterParamMapping ... France Travail uses its official public API").
    """
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=30.0)
    try:
        token = await _get_access_token(client)
        search_url = _build_search_url(site_config, filters)
        try:
            response = await client.get(search_url, headers={"Authorization": f"Bearer {token}"})
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise FranceTravailApiError(f"France Travail search request failed: {exc}") from exc
        return response.json().get("resultats", [])
    finally:
        if owns_client:
            await client.aclose()


async def ingest_france_travail_offers(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
) -> list[JobOffer]:
    """PRD Section 8.5 steps 3-4: builds the API call from `filters`, fetches
    matching offers, and (since the API already returns structured data)
    creates/links each one as a JobOffer at extractionStatus=READY directly
    -- no scrape/LLM-extraction step, unlike the HTML_SCRAPE sites'
    Mode 1/2 pipeline. Deduplicates+caps at `ingestion_job.maxOffers`
    (M3-T3) and reuses any existing globally-deduplicated JobOffer by
    sourceUrl (PRD Section 6). Rolls up the IngestionJob's aggregate counts
    (M3-T5) afterward.

    A search/auth failure (PRD Section 8.5 step 5: "per-site failure ...
    marks the IngestionJob FAILED/PARTIALLY_COMPLETED with a clear
    errorMessage — never a silent zero-result return") marks the
    IngestionJob FAILED with a non-empty errorMessage instead of raising
    past the caller and leaving it stuck at whatever status it had.
    """
    try:
        offers_raw = await search_offers(site_config, filters, http_client=http_client)
    except FranceTravailApiError as exc:
        ingestion_job.status = Ingestionjobstatus.FAILED
        ingestion_job.errorMessage = str(exc)
        ingestion_job.updatedAt = _now()
        await session.commit()
        return []

    by_url: dict[str, dict] = {}
    for offre in offers_raw:
        by_url.setdefault(_offer_source_url(offre), offre)
    retained_urls = dedupe_and_cap_urls(list(by_url.keys()), ingestion_job.maxOffers)

    job_offers: list[JobOffer] = []
    for url in retained_urls:
        job_offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == url))
        if job_offer is None:
            offre = by_url[url]
            job_offer = JobOffer(
                id=str(uuid.uuid4()),
                sourceUrl=url,
                sourceSite=Joboffersourcesite.FRANCE_TRAVAIL,
                title=offre.get("intitule"),
                company=(offre.get("entreprise") or {}).get("nom"),
                location=(offre.get("lieuTravail") or {}).get("libelle"),
                postedAt=_offer_posted_at(offre),
                structuredData=_offer_structured_data(offre),
                extractionStatus=Jobofferextractionstatus.READY,
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
    await update_ingestion_job_aggregate(session, ingestion_job.id)
    return job_offers
