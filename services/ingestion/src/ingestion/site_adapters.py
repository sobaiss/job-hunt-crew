from urllib.parse import urljoin

from bs4 import BeautifulSoup
from py_db.models import SiteConfig


class SiteAdapterConfigError(Exception):
    """Raised when a SiteConfig row lacks the selectors an HTML_SCRAPE adapter requires."""


def extract_offer_urls_via_site_config(html: str, page_url: str, site_config: SiteConfig) -> list[str]:
    """PRD Section 8.4 step 2 / 8.5 step 4: listing-page offer-URL extraction
    "via SiteConfig selectors if domain matches" — the accurate, per-site
    counterpart to listing.py's `extract_offer_urls` generic "repeated card"
    heuristic (which is the fallback for sites with no matching SiteConfig).
    Used for the 4 HTML_SCRAPE sites seeded in M4-T1 (LinkedIn, Indeed,
    Glassdoor, Welcome to the Jungle).

    Selects each listing "card" via `site_config.listItemSelector`, then the
    offer link within it via `site_config.offerLinkSelector`, resolved to an
    absolute URL against `page_url`. A card with no matching link is skipped
    rather than raising or aborting the page — selector drift on a single
    card (PRD Section 14) shouldn't take down the whole listing.
    """
    if not site_config.listItemSelector or not site_config.offerLinkSelector:
        raise SiteAdapterConfigError(
            f"listItemSelector and offerLinkSelector are required for HTML_SCRAPE site {site_config.siteKey}"
        )

    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    urls: list[str] = []
    for item in soup.select(site_config.listItemSelector):
        link = item.select_one(site_config.offerLinkSelector)
        if link is None or not link.get("href"):
            continue
        absolute_url = urljoin(page_url, link["href"])
        if absolute_url not in seen:
            seen.add(absolute_url)
            urls.append(absolute_url)
    return urls
