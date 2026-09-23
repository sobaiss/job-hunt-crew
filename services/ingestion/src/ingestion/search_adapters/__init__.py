"""Site adapters (docs/adr/0029): the per-site translation of a Search
filter into the query that site receives, registered by site key.

A site with no adapter falls back to `site_search.build_search_url`'s
`searchUrlTemplate` substitution — which is what leaves WTTJ, Indeed and
Glassdoor untouched. For a site with an adapter, `filterParamMapping`
carries only the offer-id parameter `extract_offer_id` reads.
"""

from collections.abc import Callable

from py_db.models import SiteConfig, Siteconfigsitekey

from ..site_search import build_search_url
from . import france_travail, hellowork, linkedin
from .request import SearchRequest

SiteAdapter = Callable[[SiteConfig, dict[str, str]], SearchRequest]

ADAPTERS: dict[Siteconfigsitekey, SiteAdapter] = {
    Siteconfigsitekey.FRANCE_TRAVAIL: france_travail.build,
    Siteconfigsitekey.HELLOWORK: hellowork.build,
    Siteconfigsitekey.LINKEDIN: linkedin.build,
}


def build_search_request(
    site_config: SiteConfig, filters: dict[str, str]
) -> SearchRequest:
    """The query `site_config`'s site receives for `filters`. Raises
    `site_search.SiteSearchConfigError` on a row missing what its path needs.
    """
    adapter = ADAPTERS.get(site_config.siteKey)
    if adapter is not None:
        return adapter(site_config, filters)
    return SearchRequest(build_search_url(site_config, filters))


__all__ = ["ADAPTERS", "SearchRequest", "SiteAdapter", "build_search_request"]
