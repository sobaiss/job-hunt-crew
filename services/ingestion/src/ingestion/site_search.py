import re
from urllib.parse import parse_qs, quote, urlencode, urlparse

from py_db.models import SiteConfig, Siteconfigintegrationtype

_TEMPLATE_FIELD_RE = re.compile(r"\{(\w+)\}")

# `filterParamMapping` key that identifies a single offer in a site's URLs
# (consumed by `extract_offer_id`), not a search filter — kept out of
# `build_search_url` so it can never leak into a search query string.
OFFER_ID_KEY = "id"


class SiteSearchConfigError(Exception):
    """Raised when a SiteConfig row is missing the field its integrationType requires."""


def build_search_url(site_config: SiteConfig, filters: dict[str, str]) -> str:
    """PRD Section 8.5 step 3: "Backend builds the target URL/API call from
    SiteConfig.searchUrlTemplate + filterParamMapping."

    - OFFICIAL_API sites (France Travail): builds `apiBaseUrl` + a query
      string from `filterParamMapping`, including only the filters actually
      supplied (no empty params for unset optional filters).
    - HTML_SCRAPE sites: fills `searchUrlTemplate`'s `{filterKey}` tokens
      with the URL-encoded filter value, or an empty string for any unset
      filter the template references.

    `filterParamMapping`'s `id` entry is skipped throughout — it names the
    offer-detail identifier param (`extract_offer_id`), not a search filter.
    """
    if site_config.integrationType == Siteconfigintegrationtype.OFFICIAL_API:
        if not site_config.apiBaseUrl:
            raise SiteSearchConfigError(
                f"apiBaseUrl is required for OFFICIAL_API site {site_config.siteKey}"
            )
        param_mapping = site_config.filterParamMapping or {}
        params = {
            param_name: str(filters[filter_key])
            for filter_key, param_name in param_mapping.items()
            if filter_key != OFFER_ID_KEY and filters.get(filter_key)
        }
        query = urlencode(params)
        return f"{site_config.apiBaseUrl}?{query}" if query else site_config.apiBaseUrl

    if not site_config.searchUrlTemplate:
        raise SiteSearchConfigError(
            f"searchUrlTemplate is required for HTML_SCRAPE site {site_config.siteKey}"
        )
    field_names = _TEMPLATE_FIELD_RE.findall(site_config.searchUrlTemplate)
    values = {name: quote(str(filters.get(name, "")), safe="") for name in field_names}
    return site_config.searchUrlTemplate.format(**values)


def extract_offer_id(site_config: SiteConfig, url: str) -> str | None:
    """The site's own identifier for the offer `url` points at, read the same
    data-driven way `build_search_url` reads its filters: `filterParamMapping`'s
    `"id"` entry names the query-string parameter that carries it (e.g. Indeed
    `jk`, Glassdoor `jl`).

    When that parameter is absent from `url`, falls back to the last non-empty
    path segment -- the shape the id takes on France Travail
    (`.../offres/{id}`) and the slug-based sites -- so a single rule covers
    every site without a per-site branch.
    """
    parsed = urlparse(url)
    param_name = (site_config.filterParamMapping or {}).get(OFFER_ID_KEY)
    if param_name:
        values = parse_qs(parsed.query).get(param_name) or []
        for value in values:
            if value.strip():
                return value.strip()
    segments = [segment for segment in parsed.path.split("/") if segment]
    return segments[-1] if segments else None
