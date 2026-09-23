"""France Travail OFFICIAL_API integration (PRD Section 8.5 step 3 /
Section 14: "France Travail uses its official public API
(francetravail.io), integrationType=OFFICIAL_API, not HTML scraping.").

Unlike the HTML_SCRAPE sites, the API already returns structured offer
data, so this bypasses the generic Mode 1/2 scrape+LLM-extraction pipeline
entirely: JobOffers created from a France Travail search -- or from a
SINGLE_URL request pointing at a France Travail offer -- go straight to
extractionStatus=READY with structuredData populated from the API
response.
"""

import os
from datetime import UTC, datetime

import httpx
from py_db.models import (
    IngestionJob,
    Ingestionjobstatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    SiteConfig,
)
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from sqlalchemy.ext.asyncio import AsyncSession

from .api_ingest import NormalisedOffer, link_api_offers
from .search_adapters import build_search_request

logger = get_logger(__name__)

TOKEN_URL = "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire"
DEFAULT_SCOPE = "api_offresdemploiv2 o2dsoffre"
OFFER_PATH = "/offres"

# The pipeline stage a SINGLE_URL France Travail fetch reports under: it stands
# in for `scrape.scrape_job_offer` on this path (same role -- pull one offer's
# source content ahead of the pipeline, here via the API instead of an HTML
# GET) so it shares the stage name the progress drill-down already renders.
STAGE = "scrape"


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
                # `or`, not a .get() default: an env var that is *present but
                # empty* (e.g. docker-compose passing through `${VAR:-}`) must
                # still fall back to DEFAULT_SCOPE, otherwise we POST an empty
                # scope and France Travail answers 400.
                "scope": os.environ.get("FRANCE_TRAVAIL_SCOPE") or DEFAULT_SCOPE,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # The token endpoint returns the reason (invalid_client / invalid_scope
        # / invalid_request) in the JSON body — surface it so the failure is
        # actionable rather than a bare "400 Bad Request".
        raise FranceTravailApiError(
            f"Failed to obtain France Travail access token: {exc} — {exc.response.text[:500]}"
        ) from exc
    except httpx.HTTPError as exc:
        raise FranceTravailApiError(
            f"Failed to obtain France Travail access token: {exc}"
        ) from exc
    token = response.json().get("access_token")
    if not token:
        raise FranceTravailApiError(
            "France Travail token response missing access_token"
        )
    return token


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
        "requirements": [
            c.get("libelle") for c in offre.get("competences", []) if c.get("libelle")
        ],
        "salary": (offre.get("salaire") or {}).get("libelle"),
        "contractType": offre.get("typeContratLibelle") or offre.get("typeContrat"),
        "remotePolicy": None,
        "seniority": offre.get("experienceLibelle"),
    }


def _normalised_fields(offre: dict) -> dict:
    """France Travail's own JSON mapped onto `NormalisedOffer`'s fields (minus
    `source_url`, which both callers compute separately)."""
    return {
        "title": offre.get("intitule"),
        "company": (offre.get("entreprise") or {}).get("nom"),
        "location": (offre.get("lieuTravail") or {}).get("libelle"),
        "posted_at": _offer_posted_at(offre),
        "structured_data": _offer_structured_data(offre),
    }


def _offer_job_offer_fields(offre: dict) -> dict:
    """The `JobOffer` columns the France Travail API fills directly. Both the
    SITE_SEARCH fan-out (`ingest_france_travail_offers`) and the SINGLE_URL
    fetch (`ingest_france_travail_single_offer`) set this exact same set, so an
    offer ingested either way lands identical.
    """
    return NormalisedOffer(
        source_url=_offer_source_url(offre), **_normalised_fields(offre)
    ).job_offer_fields()


async def search_offers(
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
) -> list[dict]:
    """Authenticates via OAuth2 client-credentials and calls the France
    Travail "Offres d'emploi v2" search endpoint, returning the raw
    `resultats` list from the response. The query itself is built by France
    Travail's Site adapter (`search_adapters.france_travail`).
    """
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=30.0)
    try:
        token = await _get_access_token(client)
        search_url = build_search_request(site_config, filters).url
        try:
            response = await client.get(
                search_url, headers={"Authorization": f"Bearer {token}"}
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise FranceTravailApiError(
                f"France Travail search request failed: {exc}"
            ) from exc
        return response.json().get("resultats", [])
    finally:
        if owns_client:
            await client.aclose()


async def fetch_offer(
    site_config: SiteConfig,
    offer_id: str,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> dict:
    """Authenticates with the same OAuth2 client-credentials token as
    `search_offers` and calls the France Travail "Offres d'emploi v2"
    single-offer endpoint (`GET {apiBaseUrl}/offres/{id}`), returning the raw
    offer object -- the same shape as one element of a search response's
    `resultats`.

    Raises `FranceTravailApiError` on a misconfigured SiteConfig, an
    auth/transport failure, or a `204 No Content` (the API's "offer exists but
    its content is not disclosable" response, which has no body to ingest).
    """
    if not site_config.apiBaseUrl:
        raise FranceTravailApiError(
            f"apiBaseUrl is required for OFFICIAL_API site {site_config.siteKey}"
        )
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=30.0)
    try:
        token = await _get_access_token(client)
        offer_url = f"{site_config.apiBaseUrl.rstrip('/')}{OFFER_PATH}/{offer_id}"
        try:
            response = await client.get(
                offer_url, headers={"Authorization": f"Bearer {token}"}
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise FranceTravailApiError(
                f"France Travail offer request failed: {exc}"
            ) from exc
        if response.status_code == 204 or not response.content:
            raise FranceTravailApiError(
                f"France Travail returned no content for offer {offer_id}"
            )
        return response.json()
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

    # The JobOffer lifecycle below this line is shared with every other
    # OFFICIAL_API source (`api_sources`), so it lives in `api_ingest`; what
    # stays here is only France Travail's own JSON -> NormalisedOffer mapping.
    offers = [
        NormalisedOffer(
            source_url=_offer_source_url(offre), **_normalised_fields(offre)
        )
        for offre in offers_raw
    ]
    return await link_api_offers(
        session,
        ingestion_job,
        offers,
        source_site=Joboffersourcesite.FRANCE_TRAVAIL,
    )


async def ingest_france_travail_single_offer(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    site_config: SiteConfig,
    job_offer: JobOffer,
    offer_id: str,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> JobOffer:
    """SINGLE_URL counterpart to `ingest_france_travail_offers`: fetches one
    already-linked `JobOffer`'s structured data straight from the France
    Travail "Offres d'emploi v2" single-offer endpoint and moves it to
    extractionStatus=READY -- no HTML scrape / LLM extraction, since the API
    returns structured data (PRD Section 8.5 / 14).

    Mirrors `scrape.scrape_job_offer`'s failure contract so `run_single_url_
    ingestion`'s existing rollup handles both paths identically: on an
    auth/fetch failure the `JobOffer` is left FAILED with a non-empty
    `errorMessage` and `FranceTravailApiError` is raised.
    """
    log_stage_event(
        logger,
        stage=STAGE,
        status="STARTED",
        job_offer_id=job_offer.id,
        ingestion_job_id=ingestion_job.id,
        message=f"France Travail API offer {offer_id}",
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="STARTED",
        message=f"job_offer_id={job_offer.id} (France Travail API offer {offer_id})",
        ingestion_job_id=ingestion_job.id,
    )

    try:
        offre = await fetch_offer(site_config, offer_id, http_client=http_client)
    except FranceTravailApiError as exc:
        job_offer.extractionStatus = Jobofferextractionstatus.FAILED
        job_offer.errorMessage = (
            f"Failed to fetch France Travail offer {offer_id}: {exc}"
        )
        job_offer.updatedAt = _now()
        await session.commit()
        log_stage_event(
            logger,
            stage=STAGE,
            status="FAILED",
            job_offer_id=job_offer.id,
            ingestion_job_id=ingestion_job.id,
            message=job_offer.errorMessage,
        )
        await record_pipeline_event(
            session,
            stage=STAGE,
            status="FAILED",
            message=f"job_offer_id={job_offer.id}: {job_offer.errorMessage}",
            ingestion_job_id=ingestion_job.id,
        )
        raise

    for field, value in _offer_job_offer_fields(offre).items():
        setattr(job_offer, field, value)
    job_offer.extractionStatus = Jobofferextractionstatus.READY
    job_offer.errorMessage = None
    job_offer.updatedAt = _now()
    await session.commit()

    log_stage_event(
        logger,
        stage=STAGE,
        status="SUCCEEDED",
        job_offer_id=job_offer.id,
        ingestion_job_id=ingestion_job.id,
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="SUCCEEDED",
        message=f"job_offer_id={job_offer.id} (France Travail API offer {offer_id})",
        ingestion_job_id=ingestion_job.id,
    )
    return job_offer
