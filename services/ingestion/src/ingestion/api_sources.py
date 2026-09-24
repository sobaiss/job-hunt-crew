"""OFFICIAL_API job sources other than France Travail.

PRD Section 14 named official APIs as the documented answer for the sites
whose anti-bot walls scraping can't clear, and France Travail already proved
the pattern pays off twice over: the offers arrive structured (no extraction
LLM call, docs/adr/0010's whole point) and no CAPTCHA can interrupt them.
This module generalises that from one hardcoded site to a registry.

Each source maps its own JSON onto `api_ingest.NormalisedOffer`; everything
downstream of that mapping — dedupe, JobOffer lifecycle, linking, rollup — is
`api_ingest.link_api_offers`, shared with France Travail.

**Why these two.** Both were probed live while this was written:

- **Adzuna** aggregates French postings from a wide set of boards and company
  sites, and its search vocabulary (`what`/`where`/`max_days_old`/contract
  facets) maps cleanly onto the app's own filter keys. Needs a free
  `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` pair.
- **Remotive** is key-free and covers remote roles specifically. Its API
  response carries a legal notice asking that consumers link back to the
  Remotive URL and name Remotive as the source: this pipeline stores that URL
  as `JobOffer.sourceUrl` and the site as `sourceSite=REMOTIVE`, which is
  what the UI displays, so that condition is met by construction — don't
  "canonicalise" a Remotive offer to the employer's own URL without
  revisiting it.

**Jooble was evaluated and deliberately left out**: its API host
(`jooble.org/api/...`) is itself behind a Cloudflare challenge that answered
403 to a well-formed POST with browser headers, so an adapter for it would
have the same failure mode as the scraping it was meant to replace.
"""

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx
from py_db.models import Joboffersourcesite, SiteConfig, Siteconfigsitekey
from py_db.structured_logging import get_logger

from .api_ingest import NormalisedOffer, parse_iso_datetime
from .http_client import fetch as http_fetch
from .http_client import make_http_client

logger = get_logger(__name__)

DEFAULT_RESULTS_PER_PAGE = 50


class JobApiError(Exception):
    """A configured API source could not be queried. Carries a message meant
    to land verbatim in `IngestionJob.errorMessage`."""


# The app's canonical `postedWithin` tokens (services/api POSTED_WITHIN_VALUES)
# expressed in days, for APIs that take a day count. "any" is absent on
# purpose: it means "send no date filter at all".
_POSTED_WITHIN_DAYS = {"24h": 1, "7d": 7, "14d": 14, "30d": 30}


def _clean(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


# --- Adzuna ----------------------------------------------------------------


# Search filter `contractType` -> the one Adzuna boolean facet it falls under.
# STAGE and ALTERNANCE have none.
_ADZUNA_CONTRACT_FACETS = {
    "CDI": "permanent",
    "CDD": "contract",
    "INTERIM": "contract",
    "FREELANCE": "contract",
}


def _adzuna_contract_params(contract_types: list[str] | None) -> dict[str, str]:
    """Adzuna exposes contract shape as independent boolean facets rather
    than one enum, and a request's facets all apply at once. A facet is sent
    only when it alone covers the whole selection; a selection spanning two
    facets, or holding a value with none, sends no facet — no filter is
    better than one narrower than what was asked."""
    facets = {_ADZUNA_CONTRACT_FACETS.get(value) for value in contract_types or []}
    if len(facets) != 1 or None in facets:
        return {}
    return {facets.pop(): "1"}


def _adzuna_offer(result: dict) -> NormalisedOffer | None:
    url = _clean(result.get("redirect_url"))
    if not url:
        return None
    salary_min = result.get("salary_min")
    salary_max = result.get("salary_max")
    salary = None
    if salary_min or salary_max:
        currency = result.get("salary_currency") or "EUR"
        salary = (
            f"{int(salary_min or 0)}-{int(salary_max or salary_min or 0)} {currency}"
        )
    return NormalisedOffer(
        source_url=url,
        title=_clean(result.get("title")),
        company=_clean((result.get("company") or {}).get("display_name")),
        location=_clean((result.get("location") or {}).get("display_name")),
        posted_at=parse_iso_datetime(result.get("created")),
        structured_data={
            "description": _clean(result.get("description")),
            "requirements": [],
            "salary": salary,
            "contractType": _clean(result.get("contract_type"))
            or _clean(result.get("contract_time")),
            "remotePolicy": None,
            "seniority": None,
            "category": _clean((result.get("category") or {}).get("label")),
        },
    )


async def search_adzuna(
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
    limit: int = DEFAULT_RESULTS_PER_PAGE,
) -> list[NormalisedOffer]:
    """Adzuna's `/v1/api/jobs/{country}/search/{page}` endpoint.

    `SiteConfig.apiBaseUrl` carries the country-scoped root
    (`https://api.adzuna.com/v1/api/jobs/fr`) so switching country is config,
    not code.
    """
    app_id = os.environ.get("ADZUNA_APP_ID")
    app_key = os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        raise JobApiError(
            "ADZUNA_APP_ID and ADZUNA_APP_KEY must be set to use the Adzuna "
            "source (free registration at https://developer.adzuna.com/)"
        )
    if not site_config.apiBaseUrl:
        raise JobApiError(
            f"apiBaseUrl is required for OFFICIAL_API site {site_config.siteKey.value}"
        )

    params: dict[str, str] = {
        "app_id": app_id,
        "app_key": app_key,
        "results_per_page": str(min(max(limit, 1), DEFAULT_RESULTS_PER_PAGE)),
        "content-type": "application/json",
    }
    keywords = _clean(filters.get("keywords"))
    # Adzuna has no remote facet; "remote" is expressed the way its own users
    # express it — as a search term. onsite/hybrid have no usable equivalent,
    # so they intentionally narrow nothing.
    if (filters.get("remote") or "").strip().lower() == "remote":
        keywords = f"{keywords} remote" if keywords else "remote"
    if keywords:
        params["what"] = keywords
    if location := _clean(filters.get("location")):
        params["where"] = location
    if days := _POSTED_WITHIN_DAYS.get((filters.get("postedWithin") or "").strip()):
        params["max_days_old"] = str(days)
    params.update(_adzuna_contract_params(filters.get("contractType")))

    url = f"{site_config.apiBaseUrl.rstrip('/')}/search/1"
    owns_client = http_client is None
    client = http_client or make_http_client()
    try:
        try:
            response = await http_fetch(client, url, params=params)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise JobApiError(f"Adzuna search request failed: {exc}") from exc
        payload = response.json()
    finally:
        if owns_client:
            await client.aclose()

    offers = [_adzuna_offer(result) for result in payload.get("results", [])]
    return [offer for offer in offers if offer is not None]


# --- Remotive --------------------------------------------------------------


def _remotive_offer(job: dict) -> NormalisedOffer | None:
    url = _clean(job.get("url"))
    if not url:
        return None
    return NormalisedOffer(
        source_url=url,
        title=_clean(job.get("title")),
        company=_clean(job.get("company_name")),
        location=_clean(job.get("candidate_required_location")),
        posted_at=parse_iso_datetime(job.get("publication_date")),
        structured_data={
            "description": _clean(job.get("description")),
            "requirements": [tag for tag in (job.get("tags") or []) if tag],
            "salary": _clean(job.get("salary")),
            "contractType": _clean(job.get("job_type")),
            # Every Remotive posting is remote by definition — that's the
            # whole point of the source, so it's stated rather than inferred.
            "remotePolicy": "remote",
            "seniority": None,
            "category": _clean(job.get("category")),
        },
    )


async def search_remotive(
    site_config: SiteConfig,
    filters: dict[str, str],
    *,
    http_client: httpx.AsyncClient | None = None,
    limit: int = DEFAULT_RESULTS_PER_PAGE,
) -> list[NormalisedOffer]:
    """Remotive's key-free `/api/remote-jobs` endpoint.

    Its only filters are `search`, `category` and `limit` — no location (all
    listings are remote) and no date window, so `postedWithin` is applied
    client-side by `job_api_search`'s caller rather than pretended at.
    """
    if not site_config.apiBaseUrl:
        raise JobApiError(
            f"apiBaseUrl is required for OFFICIAL_API site {site_config.siteKey.value}"
        )
    params = {"limit": str(max(limit, 1))}
    if keywords := _clean(filters.get("keywords")):
        params["search"] = keywords

    owns_client = http_client is None
    client = http_client or make_http_client()
    try:
        try:
            response = await http_fetch(client, site_config.apiBaseUrl, params=params)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise JobApiError(f"Remotive search request failed: {exc}") from exc
        payload = response.json()
    finally:
        if owns_client:
            await client.aclose()

    offers = [_remotive_offer(job) for job in payload.get("jobs", [])]
    return [offer for offer in offers if offer is not None]


# --- Registry --------------------------------------------------------------

SearchFn = Callable[..., Awaitable[list[NormalisedOffer]]]


@dataclass(frozen=True)
class JobApiSource:
    source_site: Joboffersourcesite
    search: SearchFn
    #: Env vars without which this source can't run. Surfaced by
    #: `missing_credentials` so an operator sees "not configured" rather than
    #: a failed IngestionJob.
    required_env: tuple[str, ...] = ()


#: Every OFFICIAL_API site *except* France Travail, whose OAuth2 flow and
#: per-offer endpoint stay in `france_travail.py`.
SOURCES: dict[Siteconfigsitekey, JobApiSource] = {
    Siteconfigsitekey.ADZUNA: JobApiSource(
        source_site=Joboffersourcesite.ADZUNA,
        search=search_adzuna,
        required_env=("ADZUNA_APP_ID", "ADZUNA_APP_KEY"),
    ),
    Siteconfigsitekey.REMOTIVE: JobApiSource(
        source_site=Joboffersourcesite.REMOTIVE,
        search=search_remotive,
    ),
}


def get_source(site_key: Siteconfigsitekey) -> JobApiSource | None:
    return SOURCES.get(site_key)


def missing_credentials(site_key: Siteconfigsitekey) -> tuple[str, ...]:
    """The `required_env` names that aren't set for this source — empty when
    it's ready to run."""
    source = SOURCES.get(site_key)
    if source is None:
        return ()
    return tuple(name for name in source.required_env if not os.environ.get(name))


def filter_by_posted_within(
    offers: list[NormalisedOffer], posted_within: str | None
) -> list[NormalisedOffer]:
    """Apply the app's `postedWithin` window client-side, for sources whose
    API has no date parameter (Remotive). An offer with no `postedAt` is
    kept: the source didn't say it was old, and dropping it would silently
    lose real results."""
    from datetime import UTC, datetime, timedelta

    days = _POSTED_WITHIN_DAYS.get((posted_within or "").strip())
    if not days:
        return offers
    cutoff = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days)
    return [
        offer
        for offer in offers
        if offer.posted_at is None or offer.posted_at >= cutoff
    ]
