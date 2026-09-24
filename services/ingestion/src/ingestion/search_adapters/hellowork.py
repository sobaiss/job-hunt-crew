from py_db.locations import resolve_location
from py_db.models import SiteConfig

from .request import SearchRequest, filter_value, filter_values, html_search_url

SEARCH_BASE = "https://www.hellowork.com/fr-fr/emploi/recherche.html"

# Search filter `postedWithin` -> HelloWork freshness `d` (h/d/w/m, established
# by `make verify-sites`). HelloWork has no 14-day value, so `14d` widens to a
# month — the derogation declared in `py_db.filter_support`. "any" sends no `d`.
_FRESHNESS = {"24h": "h", "7d": "w", "14d": "m", "30d": "m"}

# Search filter `remote` -> HelloWork telework `t`, a repeatable parameter
# carrying telework alone (working time is its own `ctt`). HelloWork's hybrid
# is two values, both sent.
_TELEWORK = {
    "onsite": ("Pas_teletravail",),
    "hybrid": ("Partiel", "Occasionnel"),
    "remote": ("Complet",),
}

# Search filter `contractType` -> HelloWork contract `c`, repeatable (the
# values its own search form submits). HelloWork has two facets for working
# on one's own account, both sent for FREELANCE.
_CONTRACTS = {
    "CDI": ("CDI",),
    "CDD": ("CDD",),
    "INTERIM": ("Travail_temp",),
    "STAGE": ("Stage",),
    "ALTERNANCE": ("Alternance",),
    "FREELANCE": ("Freelance", "Independant"),
}

# HelloWork's own form submits a place as its label `l` plus this companion
# region URL, keyed by the same INSEE kind and code as `py_db.locations`
# (`region/11`, `departement/69`, `departement/2A`).
_LOCALITY_URL = "http://www.rj.com/commun/localite/{kind}/{code}"


def _location_params(text: str) -> list[tuple[str, str]]:
    """The table's label and its companion URL, or an empty `l` for a value
    that resolves to nothing: HelloWork matches an unknown label as text and
    narrows to a handful of offers ("Lyonn": 18 of 17,711), so a typo is left
    out and the search runs wider instead (#216)."""
    location = resolve_location(text)
    if location is None:
        return [("l", "")]
    return [
        ("l", location.label),
        ("l_autocomplete", _LOCALITY_URL.format(kind=location.kind, code=location.code)),
    ]


def _contract_params(contract_types: list[str]) -> list[tuple[str, str]]:
    """One `c` per HelloWork value, or an empty `c` when none is chosen: the
    shape the seeded template produced."""
    values = [value for canonical in contract_types for value in _CONTRACTS.get(canonical, ())]
    return [("c", value) for value in values] or [("c", "")]


def build(site_config: SiteConfig, filters: dict) -> SearchRequest:
    params = [
        ("k", filter_value(filters, "keywords")),
        *_location_params(filter_value(filters, "location")),
        *_contract_params(filter_values(filters, "contractType")),
        ("ray", "20"),
        ("st", "relevance"),
        ("cod", "all"),
        ("msa", "0"),
    ]
    # Appended only when set, so an unfiltered search keeps the shape the
    # seeded template produced.
    freshness = _FRESHNESS.get(filter_value(filters, "postedWithin"))
    if freshness:
        params.append(("d", freshness))
    params += [("t", value) for value in _TELEWORK.get(filter_value(filters, "remote"), ())]
    return SearchRequest(html_search_url(SEARCH_BASE, params))
