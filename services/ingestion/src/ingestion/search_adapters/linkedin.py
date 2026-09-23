from py_db.models import SiteConfig

from .request import SearchRequest, filter_value, html_search_url

# fr.linkedin.com, not www: see the LINKEDIN row's comment in
# packages/prisma/prisma/seed.js.
SEARCH_BASE = "https://fr.linkedin.com/jobs/search"


def build(site_config: SiteConfig, filters: dict[str, str]) -> SearchRequest:
    # Every filter is passed through verbatim, as the seeded template did —
    # `f_TPR` in particular wants a seconds count (`r604800`), not the
    # canonical token (#212).
    return SearchRequest(
        html_search_url(
            SEARCH_BASE,
            [
                ("keywords", filter_value(filters, "keywords")),
                ("location", filter_value(filters, "location")),
                ("f_TPR", filter_value(filters, "postedWithin")),
                ("f_JT", filter_value(filters, "contractType")),
                ("f_WT", filter_value(filters, "remote")),
            ],
        )
    )
