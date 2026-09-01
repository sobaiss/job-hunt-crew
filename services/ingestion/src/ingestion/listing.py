from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

DEFAULT_MAX_PAGES = 3

# A single-offer page may carry a small "related roles" block; a genuine
# search-results / listing page carries many more repeated offer links. Above
# this many, treat the fetched page as a listing rather than one offer
# (issue #31 — "Analyse one offer" must reject a pasted listing URL).
LISTING_LINK_THRESHOLD = 6


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


def extract_offer_urls(html: str, page_url: str) -> list[str]:
    """Generic "repeated card" heuristic (PRD 8.4 step 2 fallback path, used
    when no SiteConfig selector matches the domain — SiteConfig itself
    doesn't exist until M4). Listing pages are typically a list of similarly
    structured "card" elements, each carrying one link to the offer's detail
    page; those cards' anchors usually share a common CSS class. Groups every
    `<a href>` on the page by its own (tag, sorted class list) signature,
    picks the largest group with at least 2 members (a lone link — nav,
    footer, logo — isn't a repeated card), and returns that group's hrefs
    resolved to absolute URLs against `page_url`, in document order, with
    duplicates removed. Documented as lower accuracy than a SiteConfig
    selector (PRD 8.4 step 2); returns an empty list if no repeated pattern
    is found rather than guessing.
    """
    soup = BeautifulSoup(html, "html.parser")
    groups: dict[tuple[str, ...], list[str]] = {}
    for anchor in soup.find_all("a", href=True):
        classes = tuple(sorted(anchor.get("class") or []))
        groups.setdefault(classes, []).append(anchor["href"])

    candidate_groups = [hrefs for hrefs in groups.values() if len(hrefs) >= 2]
    if not candidate_groups:
        return []
    largest_group = max(candidate_groups, key=len)

    seen: set[str] = set()
    urls: list[str] = []
    for href in largest_group:
        absolute_url = urljoin(page_url, href)
        if absolute_url not in seen:
            seen.add(absolute_url)
            urls.append(absolute_url)
    return urls


def looks_like_listing(html: str, page_url: str, *, threshold: int = LISTING_LINK_THRESHOLD) -> bool:
    """True when `html` looks like a job listing / search-results page rather
    than a single offer: the generic "repeated card" heuristic
    (`extract_offer_urls`) finds more than `threshold` distinct offer links.
    Used by the SINGLE_URL pipeline to reject a pasted listing URL with a
    distinguishable reason (issue #31) instead of scraping it as one offer.
    """
    return len(extract_offer_urls(html, page_url)) > threshold


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
