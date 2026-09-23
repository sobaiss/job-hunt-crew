from py_db.models import SiteConfig

from .request import SearchRequest, filter_value, html_search_url

SEARCH_BASE = "https://www.hellowork.com/fr-fr/emploi/recherche.html"


def build(site_config: SiteConfig, filters: dict[str, str]) -> SearchRequest:
    # `postedWithin` and `remote` are not sent, and declared UNSUPPORTED in
    # `py_db.filter_support`: HelloWork's vocabulary for those facets differs
    # from the canonical values (#213).
    return SearchRequest(
        html_search_url(
            SEARCH_BASE,
            [
                ("k", filter_value(filters, "keywords")),
                ("l", filter_value(filters, "location")),
                ("c", filter_value(filters, "contractType")),
                ("ray", "20"),
                ("st", "relevance"),
                ("cod", "all"),
                ("msa", "0"),
            ],
        )
    )
