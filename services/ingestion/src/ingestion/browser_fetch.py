"""Headless-browser fetch — the escalation tier above a plain HTTP GET.

Two site behaviours make a plain `httpx` GET return something that isn't the
offer page, and both are the browser's job:

- **A JS-execution challenge.** WTTJ sits behind an AWS WAF challenge that has
  no CAPTCHA step: run its script, get the token cookie, reach the real page.
  Issue #118 verified this by hand — a headless browser with the cookie banner
  dismissed reaches WTTJ's offer pages, which is where that fixture came from.
- **A client-rendered listing.** `SiteConfig.requiresJsRendering` has been on
  the model since the M4 seed (true for LinkedIn, WTTJ and Glassdoor) but no
  code ever read it, so those sites' listings were parsed from whatever
  server-rendered HTML happened to be there. `fetch.py` now reads it.

What this tier deliberately does *not* do is solve CAPTCHAs — Indeed's
"Security Check" and Glassdoor's Cloudflare captcha are interactive
challenges, and `blocking.detect_block` marks them `browser_solvable=False`
precisely so `fetch.py` never wastes a browser launch on them.

Playwright is an optional dependency (`ingestion[browser]`): the Lambda
handlers and the other services import this package without needing a 400MB
Chromium. Import failures surface as `BrowserUnavailableError`, which
`fetch.py` treats as "no escalation available" rather than a crash.
"""

import asyncio
import os

from py_db.structured_logging import get_logger

from .blocking import detect_block
from .http_client import DEFAULT_USER_AGENT

logger = get_logger(__name__)

DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000
#: How long to wait for a client-rendered page's own requests to settle after
#: navigation, before reading the DOM.
DEFAULT_IDLE_TIMEOUT_MS = 15_000
#: How long to keep re-reading the DOM while an interstitial is still on
#: screen. A Cloudflare/AWS WAF JS challenge typically clears in 3-8s.
DEFAULT_CHALLENGE_WAIT_SECONDS = 15.0

# Consent banners overlay the content and, on some sites, block the listing
# from rendering at all. These are the widgets the seeded French/EU sites
# actually use (Didomi on WTTJ and HelloWork, OneTrust on Glassdoor, Axeptio
# elsewhere), plus LinkedIn's own button.
_CONSENT_SELECTORS = (
    "#didomi-notice-agree-button",
    "#onetrust-accept-btn-handler",
    "#axeptio_btn_acceptAll",
    "button[data-tracking-control-name='ga-cookie.consent.accept.button']",
    "button[aria-label='Accepter']",
    "button[aria-label='Accept']",
    "button[data-testid='cookie-accept-all']",
)


class BrowserUnavailableError(RuntimeError):
    """Playwright (or its Chromium) isn't installed, or browser fetching is
    switched off. A caller should treat this as "this tier doesn't exist
    here", not as a fetch failure."""


class BrowserFetchError(RuntimeError):
    """The browser ran but couldn't retrieve the page."""


def browser_fetch_enabled() -> bool:
    """False switches the tier off without uninstalling anything — the escape
    hatch for a deployment that must not spawn browsers."""
    raw = (os.environ.get("BROWSER_FETCH_ENABLED") or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    return True


def _import_playwright():
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise BrowserUnavailableError(
            "Playwright is not installed. Install the browser extra "
            "(`uv sync --extra browser` in services/ingestion) and its Chromium "
            "(`python -m playwright install --with-deps chromium`), or set "
            "BROWSER_FETCH_ENABLED=0 to disable this tier."
        ) from exc
    return async_playwright


async def _dismiss_consent(page) -> None:
    """Best-effort: a missing banner is the normal case, never an error."""
    for selector in _CONSENT_SELECTORS:
        try:
            locator = page.locator(selector).first
            if await locator.is_visible(timeout=500):
                await locator.click(timeout=2_000)
                return
        except Exception:  # noqa: BLE001 - any failure here is a non-event
            continue


async def _await_challenge_clearance(page, url: str, wait_seconds: float) -> str:
    """Poll the DOM while a browser-solvable interstitial is still showing.

    Returns as soon as the content stops looking like a challenge, or after
    `wait_seconds` with whatever the page holds then — letting the caller's
    own `detect_block` make the final call on it.
    """
    deadline = asyncio.get_running_loop().time() + wait_seconds
    html = await page.content()
    while asyncio.get_running_loop().time() < deadline:
        detection = detect_block(status_code=200, html=html, url=url)
        if detection is None or not detection.browser_solvable:
            return html
        await asyncio.sleep(1.0)
        html = await page.content()
    return html


class BrowserFetcher:
    """A reusable Chromium. Launching one costs ~1s, so the worker keeps a
    single instance alive across fetches and opens a fresh *context* per page
    — isolated cookies/storage, without paying the launch cost every time."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._lock = asyncio.Lock()

    async def _ensure_browser(self):
        async with self._lock:
            if self._browser is not None:
                return self._browser
            async_playwright = _import_playwright()
            self._playwright = await async_playwright().start()
            try:
                self._browser = await self._playwright.chromium.launch(
                    headless=True,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                    ],
                )
            except Exception as exc:  # noqa: BLE001
                await self._playwright.stop()
                self._playwright = None
                raise BrowserUnavailableError(
                    f"Could not launch Chromium: {exc}. Run "
                    "`python -m playwright install --with-deps chromium`."
                ) from exc
            return self._browser

    async def fetch(
        self,
        url: str,
        *,
        wait_seconds: float = DEFAULT_CHALLENGE_WAIT_SECONDS,
        timeout_ms: int = DEFAULT_NAVIGATION_TIMEOUT_MS,
        idle_timeout_ms: int = DEFAULT_IDLE_TIMEOUT_MS,
    ) -> str:
        """The rendered HTML of `url` after consent dismissal and any
        JS challenge has had a chance to clear."""
        if not browser_fetch_enabled():
            raise BrowserUnavailableError(
                "Browser fetching is disabled (BROWSER_FETCH_ENABLED=0)"
            )
        browser = await self._ensure_browser()
        context = await browser.new_context(
            user_agent=os.environ.get("SCRAPER_USER_AGENT") or DEFAULT_USER_AGENT,
            locale="fr-FR",
            timezone_id="Europe/Paris",
            viewport={"width": 1440, "height": 900},
            extra_http_headers={"Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"},
        )
        try:
            page = await context.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            except Exception as exc:  # noqa: BLE001 - playwright's own errors
                raise BrowserFetchError(f"Failed to load {url}: {exc}") from exc
            await _dismiss_consent(page)
            # `domcontentloaded` fires before a client-rendered listing has
            # run its results XHR, so returning there would hand back an empty
            # shell that parses as zero offers — indistinguishable from
            # selector drift. Settle on network idle first; a page that never
            # goes idle (polling, analytics beacons) just proceeds on timeout
            # rather than failing.
            try:
                await page.wait_for_load_state("networkidle", timeout=idle_timeout_ms)
            except Exception:  # noqa: BLE001 - playwright's timeout type
                logger.info("browser_fetch_networkidle_timeout", extra={"url": url})
            html = await _await_challenge_clearance(page, url, wait_seconds)
            logger.info(
                "browser_fetch",
                extra={"url": url, "bytes": len(html)},
            )
            return html
        finally:
            await context.close()

    async def aclose(self) -> None:
        async with self._lock:
            if self._browser is not None:
                await self._browser.close()
                self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None


#: Process-wide, for the same reason `RATE_LIMITER` is: the worker drains many
#: messages over its lifetime and should launch Chromium at most once.
BROWSER_FETCHER = BrowserFetcher()


async def fetch_rendered_html(url: str, **kwargs) -> str:
    return await BROWSER_FETCHER.fetch(url, **kwargs)
