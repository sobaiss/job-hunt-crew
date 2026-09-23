from datetime import UTC, datetime, timedelta

from py_db.models import SiteConfig

from ..site_search import SiteSearchConfigError
from .request import SearchRequest, filter_value

SEARCH_PATH = "/offres/search"

# Search filter key -> "Offres d'emploi v2" parameter. `location` is not sent:
# the API takes INSEE codes, never a label, and 400s the whole search on a
# label (#215). `remote` has no parameter at all — the API has no telework
# criterion. Both are declared UNSUPPORTED in `py_db.filter_support`.
_PARAMS = {
    "keywords": "motsCles",
    "contractType": "typeContrat",
}

# The API layer hands `postedWithin` down as a relative token (POSTED_WITHIN_VALUES
# in services/api/src/api/v1.py), which the API rejects with a 400:
# `minCreationDate` must be an absolute UTC instant formatted exactly like
# "2022-10-23T08:15:42Z", sent together with a matching `maxCreationDate`.
_POSTED_WITHIN_DELTAS: dict[str, timedelta] = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "14d": timedelta(days=14),
    "30d": timedelta(days=30),
}
_CREATION_DATE_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def _creation_date_window(posted_within: str) -> dict[str, str]:
    """Empty for "any" or any unrecognised token: no date filter at all."""
    delta = _POSTED_WITHIN_DELTAS.get(posted_within.strip())
    if delta is None:
        return {}
    now = datetime.now(UTC)
    return {
        "minCreationDate": (now - delta).strftime(_CREATION_DATE_FORMAT),
        "maxCreationDate": now.strftime(_CREATION_DATE_FORMAT),
    }


def build(site_config: SiteConfig, filters: dict[str, str]) -> SearchRequest:
    # `apiBaseUrl` stays on the row: the single-offer fetch reads it too.
    if not site_config.apiBaseUrl:
        raise SiteSearchConfigError(
            f"apiBaseUrl is required for OFFICIAL_API site {site_config.siteKey}"
        )
    params = {
        param: filter_value(filters, key)
        for key, param in _PARAMS.items()
        if filters.get(key)
    }
    params |= _creation_date_window(filter_value(filters, "postedWithin"))
    return SearchRequest(f"{site_config.apiBaseUrl}{SEARCH_PATH}", params)
