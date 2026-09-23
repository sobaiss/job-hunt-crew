from py_db.models import SiteConfig

from .request import SearchRequest, filter_value, html_search_url

# fr.linkedin.com, not www: see the LINKEDIN row's comment in
# packages/prisma/prisma/seed.js.
SEARCH_BASE = "https://fr.linkedin.com/jobs/search"

# Search filter `postedWithin` -> LinkedIn freshness `f_TPR`, a seconds count
# behind a fixed `r` (established by `make verify-sites`). "any" is no window:
# `f_TPR` stays empty.
_DAY = 86400
_FRESHNESS = {
    "24h": f"r{_DAY}",
    "7d": f"r{7 * _DAY}",
    "14d": f"r{14 * _DAY}",
    "30d": f"r{30 * _DAY}",
}


def build(site_config: SiteConfig, filters: dict[str, str]) -> SearchRequest:
    # `f_JT` and `f_WT` stay in the URL but empty — the unfiltered shape the
    # seeded template produced: neither moved a result on the guest search
    # page, so each is declared UNSUPPORTED in `py_db.filter_support` (#212,
    # #214).
    return SearchRequest(
        html_search_url(
            SEARCH_BASE,
            [
                ("keywords", filter_value(filters, "keywords")),
                ("location", filter_value(filters, "location")),
                ("f_TPR", _FRESHNESS.get(filter_value(filters, "postedWithin"), "")),
                ("f_JT", ""),
                ("f_WT", ""),
            ],
        )
    )
