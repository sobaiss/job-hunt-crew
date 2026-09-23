from py_db.models import SiteConfig

from .request import SearchRequest, filter_value, html_search_url

# fr.linkedin.com, not www: see the LINKEDIN row's comment in
# packages/prisma/prisma/seed.js.
SEARCH_BASE = "https://fr.linkedin.com/jobs/search"


def build(site_config: SiteConfig, filters: dict[str, str]) -> SearchRequest:
    # `f_TPR`, `f_JT` and `f_WT` stay in the URL but empty — the unfiltered
    # shape the seeded template produced: none of them honoured what it was
    # sent, so each is declared UNSUPPORTED in `py_db.filter_support` until
    # #212 (`f_TPR` wants a seconds count, `r604800`) and #214 fix them.
    return SearchRequest(
        html_search_url(
            SEARCH_BASE,
            [
                ("keywords", filter_value(filters, "keywords")),
                ("location", filter_value(filters, "location")),
                ("f_TPR", ""),
                ("f_JT", ""),
                ("f_WT", ""),
            ],
        )
    )
