import pytest
from py_db.models import (
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)

from ingestion.site_search import SiteSearchConfigError, build_search_url


def _indeed_site_config() -> SiteConfig:
    # Mirrors packages/prisma/prisma/seed.js's INDEED row.
    return SiteConfig(
        id="site-indeed",
        siteKey=Siteconfigsitekey.INDEED,
        displayName="Indeed",
        baseUrl="https://www.indeed.com",
        searchUrlTemplate=(
            "https://www.indeed.com/jobs?q={keywords}&l={location}"
            "&fromage={postedWithin}&jt={contractType}&remotejob={remote}"
        ),
        filterParamMapping={
            "keywords": "q",
            "location": "l",
            "postedWithin": "fromage",
            "contractType": "jt",
            "remote": "remotejob",
        },
        integrationType=Siteconfigintegrationtype.HTML_SCRAPE,
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.MEDIUM,
        enabled=True,
    )


def _france_travail_site_config() -> SiteConfig:
    # Mirrors packages/prisma/prisma/seed.js's FRANCE_TRAVAIL row.
    return SiteConfig(
        id="site-france-travail",
        siteKey=Siteconfigsitekey.FRANCE_TRAVAIL,
        displayName="France Travail",
        baseUrl="https://www.francetravail.fr",
        searchUrlTemplate=None,
        filterParamMapping={
            "keywords": "motsCles",
            "location": "commune",
            "postedWithin": "minCreationDate",
            "contractType": "typeContrat",
            "remote": "travailATemps",
        },
        integrationType=Siteconfigintegrationtype.OFFICIAL_API,
        apiBaseUrl="https://api.francetravail.io/partenaire/offresdemploi/v2",
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.LOW,
        enabled=True,
    )


def test_build_search_url_html_scrape_fills_template_from_filters():
    filters = {
        "keywords": "software engineer",
        "location": "Paris",
        "postedWithin": "7d",
        "contractType": "fulltime",
        "remote": "remote",
    }

    url = build_search_url(_indeed_site_config(), filters)

    assert url == (
        "https://www.indeed.com/jobs?q=software%20engineer&l=Paris"
        "&fromage=7d&jt=fulltime&remotejob=remote"
    )


def test_build_search_url_html_scrape_blanks_unset_optional_filters():
    filters = {"keywords": "software engineer", "location": "Paris"}

    url = build_search_url(_indeed_site_config(), filters)

    assert url == "https://www.indeed.com/jobs?q=software%20engineer&l=Paris&fromage=&jt=&remotejob="


def test_build_search_url_official_api_builds_query_from_filter_param_mapping():
    filters = {"keywords": "software engineer", "location": "Paris"}

    url = build_search_url(_france_travail_site_config(), filters)

    assert url == (
        "https://api.francetravail.io/partenaire/offresdemploi/v2"
        "?motsCles=software+engineer&commune=Paris"
    )


def test_build_search_url_official_api_omits_unset_filters_entirely():
    filters = {"keywords": "software engineer"}

    url = build_search_url(_france_travail_site_config(), filters)

    assert url == "https://api.francetravail.io/partenaire/offresdemploi/v2?motsCles=software+engineer"


def test_build_search_url_official_api_with_no_filters_returns_bare_base_url():
    url = build_search_url(_france_travail_site_config(), {})

    assert url == "https://api.francetravail.io/partenaire/offresdemploi/v2"


def test_build_search_url_html_scrape_requires_search_url_template():
    site_config = _indeed_site_config()
    site_config.searchUrlTemplate = None

    with pytest.raises(SiteSearchConfigError):
        build_search_url(site_config, {})


def test_build_search_url_official_api_requires_api_base_url():
    site_config = _france_travail_site_config()
    site_config.apiBaseUrl = None

    with pytest.raises(SiteSearchConfigError):
        build_search_url(site_config, {})
