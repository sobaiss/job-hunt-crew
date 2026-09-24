"""The OFFICIAL_API source adapters (`ingestion.api_sources`).

The Remotive payload below mirrors a real response captured from
`remotive.com/api/remote-jobs` (field names verified live, values trimmed).
The Adzuna payload follows its documented `results[]` shape; its endpoint and
parameters were verified live against a keyless call, which returns a
well-formed `{"exception":"AUTH_FAIL"}` body.
"""

from datetime import datetime

import pytest
import respx
from httpx import Response
from py_db.models import Joboffersourcesite, SiteConfig, Siteconfigsitekey

from ingestion.api_sources import (
    JobApiError,
    filter_by_posted_within,
    get_source,
    missing_credentials,
    search_adzuna,
    search_remotive,
)
from ingestion.api_ingest import NormalisedOffer
from ingestion.http_client import make_http_client

ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs/fr"
REMOTIVE_BASE = "https://remotive.com/api/remote-jobs"


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")


def _site_config(site_key: Siteconfigsitekey, api_base_url: str) -> SiteConfig:
    return SiteConfig(
        id=f"site-{site_key.value}",
        siteKey=site_key,
        displayName=site_key.value,
        baseUrl="https://example.com",
        apiBaseUrl=api_base_url,
        requiresJsRendering=False,
    )


ADZUNA_PAYLOAD = {
    "count": 1,
    "results": [
        {
            "id": "4400309817",
            "title": "Développeur Backend Java",
            "created": "2026-09-07T18:24:11Z",
            "description": "Rejoignez notre équipe backend...",
            "redirect_url": "https://www.adzuna.fr/details/4400309817",
            "company": {"display_name": "Dassault Systèmes"},
            "location": {
                "display_name": "Vélizy-Villacoublay, Yvelines",
                "area": ["France", "Île-de-France"],
            },
            "salary_min": 45000,
            "salary_max": 60000,
            "contract_type": "permanent",
            "contract_time": "full_time",
            "category": {"label": "IT Jobs"},
        }
    ],
}

REMOTIVE_PAYLOAD = {
    "0-legal-notice": "Please link back to the URL found on Remotive...",
    "jobs": [
        {
            "id": 2091144,
            "url": "https://remotive.com/remote-jobs/software-dev/backend-engineer",
            "title": "Backend Engineer",
            "company_name": "TELUS Digital",
            "category": "Software Development",
            "tags": ["python", "django"],
            "job_type": "full_time",
            "publication_date": "2026-09-21T12:55:11",
            "candidate_required_location": "Europe",
            "salary": "",
            "description": "<p>Build APIs.</p>",
        }
    ],
}


# --- Adzuna ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_adzuna_without_credentials_raises_an_actionable_error(monkeypatch):
    monkeypatch.delenv("ADZUNA_APP_ID", raising=False)
    monkeypatch.delenv("ADZUNA_APP_KEY", raising=False)
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    with pytest.raises(JobApiError) as excinfo:
        await search_adzuna(config, {"keywords": "python"})
    assert "ADZUNA_APP_ID" in str(excinfo.value)


@pytest.mark.asyncio
@respx.mock
async def test_adzuna_maps_a_result_onto_a_normalised_offer(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "test-id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "test-key")
    respx.get(f"{ADZUNA_BASE}/search/1").mock(
        return_value=Response(200, json=ADZUNA_PAYLOAD)
    )
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    async with make_http_client() as client:
        offers = await search_adzuna(config, {"keywords": "java"}, http_client=client)
    assert len(offers) == 1
    offer = offers[0]
    assert offer.source_url == "https://www.adzuna.fr/details/4400309817"
    assert offer.title == "Développeur Backend Java"
    assert offer.company == "Dassault Systèmes"
    assert offer.location == "Vélizy-Villacoublay, Yvelines"
    assert offer.posted_at == datetime(2026, 9, 7, 18, 24, 11)
    assert offer.structured_data["salary"] == "45000-60000 EUR"
    assert offer.structured_data["contractType"] == "permanent"


@pytest.mark.asyncio
@respx.mock
async def test_adzuna_translates_the_app_filter_vocabulary(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "test-id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "test-key")
    route = respx.get(f"{ADZUNA_BASE}/search/1").mock(
        return_value=Response(200, json={"results": []})
    )
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    async with make_http_client() as client:
        await search_adzuna(
            config,
            {
                "keywords": "python",
                "location": "Paris",
                "postedWithin": "7d",
                "contractType": ["CDI"],
                "remote": "remote",
            },
            http_client=client,
        )
    params = route.calls[0].request.url.params
    assert params["where"] == "Paris"
    assert params["max_days_old"] == "7"
    # No remote facet exists in Adzuna's API, so it's folded into the query.
    assert params["what"] == "python remote"
    assert params["permanent"] == "1"


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize(
    ("contract_types", "sent"),
    [
        (["CDI"], {"permanent": "1"}),
        (["CDD", "INTERIM", "FREELANCE"], {"contract": "1"}),
        # Adzuna's facets combine as an AND, so a selection spanning both, or
        # holding a value with no facet, sends none: wider, never narrower.
        (["CDI", "CDD"], {}),
        (["STAGE"], {}),
        (["CDD", "ALTERNANCE"], {}),
    ],
)
async def test_adzuna_sends_a_contract_facet_only_when_one_covers_the_selection(
    monkeypatch, contract_types, sent
):
    monkeypatch.setenv("ADZUNA_APP_ID", "test-id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "test-key")
    route = respx.get(f"{ADZUNA_BASE}/search/1").mock(
        return_value=Response(200, json={"results": []})
    )
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    async with make_http_client() as client:
        await search_adzuna(config, {"contractType": contract_types}, http_client=client)
    params = dict(route.calls[0].request.url.params)
    facets = {k: v for k, v in params.items() if k in ("permanent", "contract", "part_time", "full_time")}
    assert facets == sent


@pytest.mark.asyncio
@respx.mock
async def test_adzuna_sends_no_date_filter_for_any(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "test-id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "test-key")
    route = respx.get(f"{ADZUNA_BASE}/search/1").mock(
        return_value=Response(200, json={"results": []})
    )
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    async with make_http_client() as client:
        await search_adzuna(config, {"postedWithin": "any"}, http_client=client)
    assert "max_days_old" not in route.calls[0].request.url.params


@pytest.mark.asyncio
@respx.mock
async def test_adzuna_http_failure_becomes_a_job_api_error(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "test-id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "bad-key")
    respx.get(f"{ADZUNA_BASE}/search/1").mock(
        return_value=Response(400, json={"exception": "AUTH_FAIL"})
    )
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    async with make_http_client() as client:
        with pytest.raises(JobApiError):
            await search_adzuna(config, {}, http_client=client)


@pytest.mark.asyncio
@respx.mock
async def test_adzuna_skips_a_result_with_no_url(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "test-id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "test-key")
    respx.get(f"{ADZUNA_BASE}/search/1").mock(
        return_value=Response(200, json={"results": [{"title": "No link"}]})
    )
    config = _site_config(Siteconfigsitekey.ADZUNA, ADZUNA_BASE)
    async with make_http_client() as client:
        assert await search_adzuna(config, {}, http_client=client) == []


# --- Remotive --------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_remotive_maps_a_job_onto_a_normalised_offer():
    respx.get(REMOTIVE_BASE).mock(return_value=Response(200, json=REMOTIVE_PAYLOAD))
    config = _site_config(Siteconfigsitekey.REMOTIVE, REMOTIVE_BASE)
    async with make_http_client() as client:
        offers = await search_remotive(
            config, {"keywords": "python"}, http_client=client
        )
    assert len(offers) == 1
    offer = offers[0]
    # The Remotive URL is kept as sourceUrl on purpose: their API's legal
    # notice requires linking back to it and crediting Remotive.
    assert offer.source_url.startswith("https://remotive.com/remote-jobs/")
    assert offer.company == "TELUS Digital"
    assert offer.structured_data["remotePolicy"] == "remote"
    assert offer.structured_data["requirements"] == ["python", "django"]


@pytest.mark.asyncio
@respx.mock
async def test_remotive_needs_no_credentials():
    assert missing_credentials(Siteconfigsitekey.REMOTIVE) == ()
    respx.get(REMOTIVE_BASE).mock(return_value=Response(200, json={"jobs": []}))
    config = _site_config(Siteconfigsitekey.REMOTIVE, REMOTIVE_BASE)
    async with make_http_client() as client:
        assert await search_remotive(config, {}, http_client=client) == []


# --- Registry and shared helpers -------------------------------------------


def test_registry_maps_each_source_to_its_source_site():
    assert get_source(Siteconfigsitekey.ADZUNA).source_site is Joboffersourcesite.ADZUNA
    assert (
        get_source(Siteconfigsitekey.REMOTIVE).source_site
        is Joboffersourcesite.REMOTIVE
    )
    # France Travail keeps its own module (OAuth2 + a per-offer endpoint).
    assert get_source(Siteconfigsitekey.FRANCE_TRAVAIL) is None


def test_missing_credentials_lists_only_the_unset_ones(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "set")
    monkeypatch.delenv("ADZUNA_APP_KEY", raising=False)
    assert missing_credentials(Siteconfigsitekey.ADZUNA) == ("ADZUNA_APP_KEY",)


def test_posted_within_is_applied_client_side_for_sources_without_a_date_param():
    recent = NormalisedOffer(source_url="https://x/1", posted_at=datetime.now())
    old = NormalisedOffer(source_url="https://x/2", posted_at=datetime(2020, 1, 1))
    undated = NormalisedOffer(source_url="https://x/3")
    kept = filter_by_posted_within([recent, old, undated], "7d")
    # The undated offer is kept: the source didn't say it was old, and
    # dropping it would silently lose a real result.
    assert [offer.source_url for offer in kept] == ["https://x/1", "https://x/3"]


def test_posted_within_any_filters_nothing():
    offers = [NormalisedOffer(source_url="https://x/2", posted_at=datetime(2020, 1, 1))]
    assert filter_by_posted_within(offers, "any") == offers
