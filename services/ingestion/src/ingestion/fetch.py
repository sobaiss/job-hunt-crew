"""The one place a page is fetched, and the escalation ladder it climbs.

`scrape.py` (one offer) and `listing.py` (a search-results page) both used to
call `client.get(...)` directly and treat whatever came back as content. They
now both call `fetch_page`, which runs the same three-rung ladder:

1. **Plain HTTP** through the hardened shared client (`http_client`) —
   identifying headers, per-host pacing, bounded retry. Cheap, and enough for
   HelloWork, LinkedIn and most ATS-hosted pages.
2. **Headless browser** (`browser_fetch`) — entered either because
   `SiteConfig.requiresJsRendering` says the listing is client-rendered, or
   because rung 1 came back with a block that `blocking.detect_block` judged
   `browser_solvable` (a JS challenge with no CAPTCHA, like WTTJ's AWS WAF).
3. **Stop, with the reason.** A CAPTCHA wall (Indeed, Glassdoor) or an
   IP-reputation denial is not something this process can solve, so it fails
   immediately with a `BLOCKED_<KIND>:` message an operator can act on —
   rather than retrying into the same wall, or (the old behaviour) storing
   the interstitial in S3 as a successful scrape and discovering one stage
   later that it had no title.

The rung-3 outcome is a real answer, not a failure of this module: PRD
Section 14 always listed official APIs and scraping-as-a-service as the
documented fallbacks for exactly these sites, and `api_sources.py` is the
first of those two.
"""

import httpx
from py_db.models import SiteConfig
from py_db.structured_logging import get_logger

from .blocking import BlockDetection, detect_block
from .browser_fetch import (
    BrowserFetchError,
    BrowserUnavailableError,
    browser_fetch_enabled,
    fetch_rendered_html,
)
from .http_client import fetch as http_fetch
from .http_client import make_http_client

logger = get_logger(__name__)


class FetchError(Exception):
    """A page could not be retrieved. Carries `detection` when the cause was
    an identified anti-bot block rather than a transport/status failure."""

    def __init__(self, message: str, *, detection: BlockDetection | None = None):
        super().__init__(message)
        self.detection = detection

    @property
    def blocked(self) -> bool:
        return self.detection is not None


async def _try_browser(url: str) -> tuple[str | None, str | None]:
    """`(html, None)` on success, `(None, reason)` when the tier is
    unavailable or failed — never raises, so a browser problem degrades to
    "rung 2 didn't help" instead of masking rung 1's real block reason."""
    if not browser_fetch_enabled():
        return None, "browser fetching is disabled"
    try:
        return await fetch_rendered_html(url), None
    except BrowserUnavailableError as exc:
        return None, str(exc)
    except BrowserFetchError as exc:
        return None, str(exc)
    except Exception as exc:  # noqa: BLE001 - playwright raises broadly
        return None, f"browser fetch failed: {exc}"


async def fetch_page(
    url: str,
    *,
    site_config: SiteConfig | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> str:
    """The HTML at `url`, escalating through the ladder above.

    `http_client` stays injectable for the same reason it always was: the
    test suite drives these paths with respx. An injected client skips
    nothing — it still gets pacing, retry and block detection.

    Raises `FetchError` (with `.detection` set when the cause was a block).
    """
    prefers_browser = bool(site_config is not None and site_config.requiresJsRendering)

    if prefers_browser:
        html, reason = await _try_browser(url)
        if html is not None:
            detection = detect_block(status_code=200, html=html, url=url)
            if detection is None:
                return html
            logger.warning(
                "fetch_blocked_after_browser",
                extra={"url": url, "block_kind": detection.kind.value},
            )
            raise FetchError(detection.error_message, detection=detection)
        # The site is known to need JS but we have no browser — fall through
        # to plain HTTP anyway. It may still carry enough server-rendered
        # markup (LinkedIn's guest pages do), and a real answer beats none.
        logger.warning(
            "browser_tier_unavailable",
            extra={"url": url, "reason": reason},
        )

    owns_client = http_client is None
    client = http_client or make_http_client()
    try:
        try:
            response = await http_fetch(client, url)
        except httpx.HTTPError as exc:
            raise FetchError(f"Failed to fetch {url}: {exc}") from exc

        html = response.text
        detection = detect_block(
            status_code=response.status_code,
            html=html,
            url=url,
            retry_after=response.headers.get("Retry-After"),
        )

        if detection is None:
            try:
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise FetchError(f"Failed to fetch {url}: {exc}") from exc
            return html

        logger.warning(
            "fetch_blocked",
            extra={
                "url": url,
                "status": response.status_code,
                "block_kind": detection.kind.value,
                "browser_solvable": detection.browser_solvable,
            },
        )

        # Rung 2, unless rung 1 already came from the browser (prefers_browser
        # fell through) or the block is one no browser solves.
        if detection.browser_solvable and not prefers_browser:
            rendered, reason = await _try_browser(url)
            if rendered is not None:
                after = detect_block(status_code=200, html=rendered, url=url)
                if after is None:
                    logger.info("fetch_unblocked_by_browser", extra={"url": url})
                    return rendered
                detection = after
            else:
                logger.warning(
                    "browser_tier_unavailable",
                    extra={"url": url, "reason": reason},
                )

        raise FetchError(detection.error_message, detection=detection)
    finally:
        if owns_client:
            await client.aclose()
