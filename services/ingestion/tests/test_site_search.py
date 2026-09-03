import pytest
from py_db.models import (
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)

from ingestion.site_search import SiteSearchConfigError, build_search_url, extract_offer_id


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
            "id": "jk",
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
            "id": "id",
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


def test_build_search_url_ignores_the_id_mapping_entry():
    # `id` in filterParamMapping is for offer-detail extraction, not search —
    # a SITE_SEARCH `filters` dict never carries it, so it must not leak into
    # the built query string.
    url = build_search_url(_france_travail_site_config(), {"keywords": "python", "id": "213CTNR"})

    assert "213CTNR" not in url
    assert url == "https://api.francetravail.io/partenaire/offresdemploi/v2?motsCles=python"


def test_extract_offer_id_reads_the_mapped_query_param():
    offer_id = extract_offer_id(
        _indeed_site_config(), "https://fr.indeed.com/viewjob?jk=1a2b3c4d5e6f7g8h&from=serp"
    )

    assert offer_id == "1a2b3c4d5e6f7g8h"


def test_extract_offer_id_falls_back_to_last_path_segment_for_api_url():
    # France Travail's partner-API URL: the id is the last path segment, not a
    # query param — the fallback branch.
    offer_id = extract_offer_id(
        _france_travail_site_config(),
        "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/213CTNR",
    )

    assert offer_id == "213CTNR"


def test_extract_offer_id_falls_back_to_last_path_segment_for_candidate_url():
    offer_id = extract_offer_id(
        _france_travail_site_config(),
        "https://candidat.francetravail.fr/offres/recherche/detail/213CTNR/",
    )

    assert offer_id == "213CTNR"


def test_extract_offer_id_prefers_the_query_param_over_the_path_segment():
    site_config = _indeed_site_config()
    offer_id = extract_offer_id(site_config, "https://fr.indeed.com/viewjob?jk=ABC123")

    # Last path segment would be "viewjob" — the mapped `jk` param must win.
    assert offer_id == "ABC123"


def test_extract_offer_id_returns_none_when_nothing_identifiable():
    assert extract_offer_id(_indeed_site_config(), "https://fr.indeed.com/") is None
