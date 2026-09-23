from dataclasses import dataclass, field
from urllib.parse import quote, urlencode


@dataclass(frozen=True)
class SearchRequest:
    """What one site receives for a Search filter: a URL for an HTML site
    (`base` is the whole URL, `params` empty), or a base plus parameters for
    an API source. One type for both, so the pipeline has one call site.
    """

    base: str
    params: dict[str, str] = field(default_factory=dict)

    @property
    def url(self) -> str:
        query = urlencode(self.params)
        return f"{self.base}?{query}" if query else self.base


def filter_value(filters: dict[str, str], key: str) -> str:
    """A filter's value as text, `""` when unset. The API stores an unset
    optional filter as an explicit `None`, which `filters.get`'s default
    alone would stringify into a literal "None".
    """
    return str(filters.get(key) or "")


def html_search_url(base: str, params: list[tuple[str, str]]) -> str:
    """An HTML site's search URL, every param present even when empty —
    the shape `SiteConfig.searchUrlTemplate` substitution produced, `%20`
    spaces included.
    """
    return f"{base}?{urlencode(params, quote_via=quote)}"
