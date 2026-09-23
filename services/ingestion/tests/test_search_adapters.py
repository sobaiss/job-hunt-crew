"""Site adapters (docs/adr/0029): given a Search filter, the exact query each
site receives.

These pin today's queries on purpose. A filter a site cannot honour yet is
not sent (France Travail's `location` and `remote`, LinkedIn's `f_JT`/
`f_WT`) and is declared
UNSUPPORTED in `py_db.filter_support` (#210); each later ticket changes one
of these expectations deliberately.

The SiteConfigs are skeletons, not the seeded rows: the adapter, not the
row, carries the site's search knowledge.
"""

from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from py_db.models import (
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)

from ingestion.search_adapters import SearchRequest, build_search_request
from ingestion.site_search import SiteSearchConfigError

FRANCE_TRAVAIL_API = "https://api.francetravail.io/partenaire/offresdemploi/v2"

ALL_FILTERS = {
    "keywords": "software engineer",
    "location": "Paris",
    "postedWithin": "7d",
    "contractType": "CDI",
    "remote": "remote",
}


def _skeleton(
    site_key: Siteconfigsitekey,
    integration_type: Siteconfigintegrationtype = Siteconfigintegrationtype.HTML_SCRAPE,
    **overrides,
) -> SiteConfig:
    fields = {
        "id": f"site-{site_key.value.lower()}",
        "siteKey": site_key,
        "displayName": site_key.value,
        "baseUrl": "https://example.com",
        "integrationType": integration_type,
        "requiresJsRendering": False,
        "antiBotRiskLevel": Siteconfigantibotrisklevel.MEDIUM,
        "enabled": True,
    }
    fields.update(overrides)
    return SiteConfig(**fields)


def _france_travail() -> SiteConfig:
    return _skeleton(
        Siteconfigsitekey.FRANCE_TRAVAIL,
        Siteconfigintegrationtype.OFFICIAL_API,
        apiBaseUrl=FRANCE_TRAVAIL_API,
    )


# --- LinkedIn --------------------------------------------------------------


def test_linkedin_sends_keywords_location_and_freshness_and_leaves_the_rest_empty():
    request = build_search_request(_skeleton(Siteconfigsitekey.LINKEDIN), ALL_FILTERS)

    assert request.url == (
        "https://fr.linkedin.com/jobs/search?keywords=software%20engineer"
        "&location=Paris&f_TPR=r604800&f_JT=&f_WT="
    )


def test_linkedin_keeps_empty_params_for_unset_filters():
    # Explicit `None` is how the API stores an unset optional filter.
    request = build_search_request(
        _skeleton(Siteconfigsitekey.LINKEDIN),
        {"keywords": "python", "location": None},
    )

    assert request.url == (
        "https://fr.linkedin.com/jobs/search?keywords=python"
        "&location=&f_TPR=&f_JT=&f_WT="
    )


@pytest.mark.parametrize(
    ("posted_within", "freshness"),
    [
        ("24h", "r86400"),
        ("7d", "r604800"),
        ("14d", "r1209600"),
        ("30d", "r2592000"),
        # "any" is no window at all: `f_TPR` stays empty.
        ("any", ""),
    ],
)
def test_linkedin_sends_freshness_as_a_seconds_count(posted_within, freshness):
    request = build_search_request(
        _skeleton(Siteconfigsitekey.LINKEDIN),
        {"keywords": "python", "postedWithin": posted_within},
    )

    assert request.url == (
        "https://fr.linkedin.com/jobs/search?keywords=python"
        f"&location=&f_TPR={freshness}&f_JT=&f_WT="
    )


def test_linkedin_ignores_the_row_template():
    site_config = _skeleton(
        Siteconfigsitekey.LINKEDIN, searchUrlTemplate="https://stale.example/{keywords}"
    )

    request = build_search_request(site_config, {"keywords": "python"})

    assert request.url.startswith("https://fr.linkedin.com/jobs/search?")


# --- HelloWork -------------------------------------------------------------


def test_hellowork_maps_every_filter_and_keeps_fixed_defaults():
    request = build_search_request(_skeleton(Siteconfigsitekey.HELLOWORK), ALL_FILTERS)

    assert request.url == (
        "https://www.hellowork.com/fr-fr/emploi/recherche.html?k=software%20engineer"
        "&l=Paris&c=CDI&ray=20&st=relevance&cod=all&msa=0&d=w&t=Complet"
    )


@pytest.mark.parametrize(
    ("posted_within", "freshness"),
    [
        ("24h", "&d=h"),
        ("7d", "&d=w"),
        # No 14-day value on HelloWork: widened to a month, never narrowed
        # to a week (the derogation in `py_db.filter_support`).
        ("14d", "&d=m"),
        ("30d", "&d=m"),
        ("any", ""),
    ],
)
def test_hellowork_sends_its_own_freshness_value(posted_within, freshness):
    request = build_search_request(
        _skeleton(Siteconfigsitekey.HELLOWORK),
        {"keywords": "python", "postedWithin": posted_within},
    )

    assert request.url == (
        "https://www.hellowork.com/fr-fr/emploi/recherche.html?k=python&l="
        f"&c=&ray=20&st=relevance&cod=all&msa=0{freshness}"
    )


@pytest.mark.parametrize(
    ("remote", "telework"),
    [
        ("onsite", "&t=Pas_teletravail"),
        # HelloWork splits hybrid into two values; `t` repeats to carry both.
        ("hybrid", "&t=Partiel&t=Occasionnel"),
        ("remote", "&t=Complet"),
    ],
)
def test_hellowork_sends_its_own_telework_values(remote, telework):
    request = build_search_request(
        _skeleton(Siteconfigsitekey.HELLOWORK),
        {"keywords": "python", "remote": remote},
    )

    assert request.url == (
        "https://www.hellowork.com/fr-fr/emploi/recherche.html?k=python&l="
        f"&c=&ray=20&st=relevance&cod=all&msa=0{telework}"
    )


def test_hellowork_blanks_unset_filters():
    request = build_search_request(
        _skeleton(Siteconfigsitekey.HELLOWORK),
        {"keywords": "ingenieur", "location": None, "contractType": None},
    )

    assert request.url == (
        "https://www.hellowork.com/fr-fr/emploi/recherche.html?k=ingenieur&l="
        "&c=&ray=20&st=relevance&cod=all&msa=0"
    )


# --- France Travail --------------------------------------------------------


def test_france_travail_maps_filters_onto_the_search_endpoint():
    filters = {k: v for k, v in ALL_FILTERS.items() if k != "postedWithin"}

    request = build_search_request(_france_travail(), filters)

    assert request.url == (
        f"{FRANCE_TRAVAIL_API}/offres/search?motsCles=software+engineer"
        "&typeContrat=CDI"
    )


def test_france_travail_is_a_base_plus_parameters():
    request = build_search_request(_france_travail(), {"keywords": "python"})

    assert request == SearchRequest(
        base=f"{FRANCE_TRAVAIL_API}/offres/search", params={"motsCles": "python"}
    )


def test_france_travail_with_no_filters_is_the_bare_search_endpoint():
    request = build_search_request(_france_travail(), {"keywords": None})

    assert request.url == f"{FRANCE_TRAVAIL_API}/offres/search"


def test_france_travail_resolves_posted_within_to_an_absolute_window():
    request = build_search_request(
        _france_travail(), {"keywords": "python", "postedWithin": "14d"}
    )

    params = {k: v[0] for k, v in parse_qs(urlparse(request.url).query).items()}
    assert list(params) == ["motsCles", "minCreationDate", "maxCreationDate"]
    lo = datetime.strptime(params["minCreationDate"], "%Y-%m-%dT%H:%M:%SZ")
    hi = datetime.strptime(params["maxCreationDate"], "%Y-%m-%dT%H:%M:%SZ")
    assert hi - lo == timedelta(days=14)


def test_france_travail_sends_no_window_for_any():
    request = build_search_request(
        _france_travail(), {"keywords": "python", "postedWithin": "any"}
    )

    assert request.url == f"{FRANCE_TRAVAIL_API}/offres/search?motsCles=python"


def test_france_travail_requires_api_base_url():
    with pytest.raises(SiteSearchConfigError):
        build_search_request(
            _skeleton(
                Siteconfigsitekey.FRANCE_TRAVAIL, Siteconfigintegrationtype.OFFICIAL_API
            ),
            {},
        )


# --- Template fallback -----------------------------------------------------


def test_a_site_with_no_adapter_falls_back_to_the_row_template():
    site_config = _skeleton(
        Siteconfigsitekey.INDEED,
        searchUrlTemplate="https://www.indeed.com/jobs?q={keywords}&l={location}",
    )

    request = build_search_request(site_config, {"keywords": "a b", "location": "Lyon"})

    assert request.url == "https://www.indeed.com/jobs?q=a%20b&l=Lyon"


def test_the_fallback_still_requires_a_template():
    with pytest.raises(SiteSearchConfigError):
        build_search_request(_skeleton(Siteconfigsitekey.WTTJ), {})
