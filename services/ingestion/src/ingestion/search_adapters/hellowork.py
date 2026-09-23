from py_db.models import SiteConfig

from .request import SearchRequest, filter_value, html_search_url

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


def build(site_config: SiteConfig, filters: dict[str, str]) -> SearchRequest:
    params = [
        ("k", filter_value(filters, "keywords")),
        ("l", filter_value(filters, "location")),
        ("c", filter_value(filters, "contractType")),
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
