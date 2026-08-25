import re
from urllib.parse import quote, urlencode

from py_db.models import SiteConfig, Siteconfigintegrationtype

_TEMPLATE_FIELD_RE = re.compile(r"\{(\w+)\}")


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
            if filters.get(filter_key)
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
