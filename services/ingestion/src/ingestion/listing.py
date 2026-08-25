from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

DEFAULT_MAX_PAGES = 3


class ListingFetchError(Exception):
    pass


def _find_next_page_url(html: str, page_url: str) -> str | None:
    """Generic next-page heuristic: an <a rel="next" href="..."> link,
    resolved against the current page's URL. SiteConfig-specific pagination
    (if a site needs something else) is out of scope for this generic path.
    """
    soup = BeautifulSoup(html, "html.parser")
    next_link = soup.find("a", rel="next")
    if next_link is None or not next_link.get("href"):
        return None
    return urljoin(page_url, next_link["href"])


async def fetch_listing_pages(
    start_url: str,
    *,
    http_client: httpx.AsyncClient | None = None,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> list[str]:
    """Fetches a listing/search-results page and follows its "next page"
    links, capped at `max_pages` fetches total (PRD 8.4 step 2: "pagination
    capped, default 3 pages"). Stops early if a page has no next-page link.
    Returns the fetched pages' raw HTML, in page order.
    """
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(follow_redirects=True, timeout=30.0)
    pages: list[str] = []
    try:
        page_url: str | None = start_url
        while page_url is not None and len(pages) < max_pages:
            try:
                response = await client.get(page_url)
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise ListingFetchError(f"Failed to fetch {page_url}: {exc}") from exc
            html = response.text
            pages.append(html)
            page_url = _find_next_page_url(html, page_url)
    finally:
        if owns_client:
            await client.aclose()
    return pages
