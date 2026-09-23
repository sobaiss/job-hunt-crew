"""FilterSupport declarations (docs/adr/0030) agree with what each site is
actually sent.

For every (site, filter) pair: a pair declared SUPPORTED or APPROXIMATED
must change what the site receives when that filter is set, and a pair
declared UNSUPPORTED must change nothing. "What the site receives" is the
query a Site adapter builds, or, for an API source, the parameters it sends
plus the offers this pipeline keeps afterwards — post-filtering counts as
honouring a filter (Remotive's `postedWithin`).

The SiteConfigs are skeletons, not the seeded rows: no database, no seed.
WTTJ is the one enabled site left out. It is on the template fallback path,
so its query lives in its seeded row rather than in code this test can
reach, and its search is stale anyway (see its SiteConfig notes): it is
declared UNSUPPORTED throughout.
"""

import pytest
import respx
from httpx import Response
from py_db.filter_support import (
    FILTER_SUPPORT,
    SEARCH_FILTER_KEYS,
    FilterSupportLevel,
)
from py_db.models import (
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)

from ingestion.api_sources import filter_by_posted_within, get_source
from ingestion.search_adapters import build_search_request

ENABLED_SITES = {
    Siteconfigsitekey.FRANCE_TRAVAIL,
    Siteconfigsitekey.HELLOWORK,
    Siteconfigsitekey.LINKEDIN,
    Siteconfigsitekey.WTTJ,
    Siteconfigsitekey.ADZUNA,
    Siteconfigsitekey.REMOTIVE,
}

# One canonical value per filter, driven through each site.
PROBE_VALUES = {
    "keywords": "python",
    "location": "Ile-de-France",
    "postedWithin": "7d",
    "contractType": "CDI",
    "remote": "remote",
    "experienceLevel": "senior",
}

API_BASES = {
    Siteconfigsitekey.FRANCE_TRAVAIL: "https://api.francetravail.io/partenaire/offresdemploi/v2",
    Siteconfigsitekey.ADZUNA: "https://api.adzuna.com/v1/api/jobs/fr",
    Siteconfigsitekey.REMOTIVE: "https://remotive.com/api/remote-jobs",
}

# A stale offer each mocked API source returns, so a date window applied
# after the fact is visible in what the pipeline keeps.
_STALE_ADZUNA = {"redirect_url": "https://adzuna.example/1", "created": "2000-01-01T00:00:00Z"}
_STALE_REMOTIVE = {"url": "https://remotive.example/1", "publication_date": "2000-01-01T00:00:00"}


def _skeleton(site_key: Siteconfigsitekey) -> SiteConfig:
    return SiteConfig(
        id=f"site-{site_key.value.lower()}",
        siteKey=site_key,
        displayName=site_key.value,
        baseUrl="https://example.com",
        integrationType=(
            Siteconfigintegrationtype.OFFICIAL_API
            if site_key in API_BASES
            else Siteconfigintegrationtype.HTML_SCRAPE
        ),
        apiBaseUrl=API_BASES.get(site_key),
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.MEDIUM,
        enabled=True,
    )


async def _api_source_receives(site_key: Siteconfigsitekey, filters: dict) -> tuple:
    source = get_source(site_key)
    with respx.mock:
        route = respx.get(url__startswith=API_BASES[site_key]).mock(
            return_value=Response(
                200,
                json={"results": [_STALE_ADZUNA], "jobs": [_STALE_REMOTIVE]},
            )
        )
        offers = await source.search(_skeleton(site_key), filters)
        params = dict(route.calls.last.request.url.params)
    # Credentials are not part of the query a filter shapes.
    params.pop("app_id", None)
    params.pop("app_key", None)
    kept = filter_by_posted_within(offers, filters.get("postedWithin"))
    return params, len(kept)


async def _site_receives(site_key: Siteconfigsitekey, filters: dict) -> object:
    if get_source(site_key) is not None:
        return await _api_source_receives(site_key, filters)
    return build_search_request(_skeleton(site_key), filters).url


@pytest.fixture(autouse=True)
def _adzuna_credentials(monkeypatch):
    monkeypatch.setenv("ADZUNA_APP_ID", "id")
    monkeypatch.setenv("ADZUNA_APP_KEY", "key")


def test_every_enabled_site_declares_every_search_filter():
    for site_key in ENABLED_SITES:
        declared = FILTER_SUPPORT[site_key]
        assert set(declared) == set(SEARCH_FILTER_KEYS), site_key
        for support in declared.values():
            assert support.reason.strip(), site_key


def test_experience_level_is_honoured_nowhere():
    # Why the form hides the field (docs/adr/0030).
    for declared in FILTER_SUPPORT.values():
        assert declared["experienceLevel"].level is FilterSupportLevel.UNSUPPORTED


@pytest.mark.parametrize(
    ("site_key", "filter_key"),
    [
        (site_key, filter_key)
        for site_key in sorted(ENABLED_SITES - {Siteconfigsitekey.WTTJ})
        for filter_key in SEARCH_FILTER_KEYS
    ],
)
async def test_declaration_matches_what_the_site_receives(site_key, filter_key):
    # Keywords set on both sides, so the baseline is a real search.
    baseline = {"keywords": "developer"}
    probe = dict(baseline)
    if filter_key == "keywords":
        probe["keywords"] = PROBE_VALUES["keywords"]
    else:
        probe[filter_key] = PROBE_VALUES[filter_key]

    changed = await _site_receives(site_key, probe) != await _site_receives(
        site_key, baseline
    )

    level = FILTER_SUPPORT[site_key][filter_key].level
    if level is FilterSupportLevel.UNSUPPORTED:
        assert not changed, f"{site_key.value} sends {filter_key} yet declares it UNSUPPORTED"
    else:
        assert changed, f"{site_key.value} declares {filter_key} {level.value} yet sends nothing"


def _derogations():
    return [
        (site_key, filter_key, value, derogation)
        for site_key in sorted(ENABLED_SITES - {Siteconfigsitekey.WTTJ})
        for filter_key, support in FILTER_SUPPORT[site_key].items()
        for value, derogation in support.derogations.items()
    ]


def test_hellowork_widens_14_days_to_a_month():
    derogation = FILTER_SUPPORT[Siteconfigsitekey.HELLOWORK]["postedWithin"].derogations["14d"]

    assert derogation.level is FilterSupportLevel.APPROXIMATED
    assert derogation.substitute == "30d"


# Freshness windows, narrowest first: a derogation widens, never narrows.
_POSTED_WITHIN_ORDER = ["24h", "7d", "14d", "30d", "any"]


@pytest.mark.parametrize(("site_key", "filter_key", "value", "derogation"), _derogations())
async def test_a_derogation_sends_its_substitute(site_key, filter_key, value, derogation):
    # The substitute named to the candidate is what the site really receives.
    assert derogation.substitute is not None
    as_asked = await _site_receives(site_key, {"keywords": "developer", filter_key: value})
    as_substituted = await _site_receives(
        site_key, {"keywords": "developer", filter_key: derogation.substitute}
    )

    assert as_asked == as_substituted
    if filter_key == "postedWithin":
        assert _POSTED_WITHIN_ORDER.index(derogation.substitute) > _POSTED_WITHIN_ORDER.index(value)


@pytest.mark.parametrize(
    "site_key",
    [
        site_key
        for site_key in sorted(ENABLED_SITES - {Siteconfigsitekey.WTTJ})
        if FILTER_SUPPORT[site_key]["location"].level is not FilterSupportLevel.UNSUPPORTED
    ],
)
async def test_when_unresolved_matches_what_an_unresolved_location_sends(site_key):
    # "Lyonn" is neither a region nor a department: a site declaring
    # `when_unresolved` must send exactly what it sends with no location,
    # and a site declaring none must still send the text as typed.
    baseline = {"keywords": "developer"}
    changed = await _site_receives(site_key, baseline | {"location": "Lyonn"}) != (
        await _site_receives(site_key, baseline)
    )

    when_unresolved = FILTER_SUPPORT[site_key]["location"].when_unresolved
    if when_unresolved is FilterSupportLevel.UNSUPPORTED:
        assert not changed, f"{site_key.value} sends an unresolved location"
    else:
        assert changed, f"{site_key.value} drops an unresolved location undeclared"
