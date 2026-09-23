"""The shared HTTP client every scrape/listing fetch goes through.

Before this module, `scrape.py` and `listing.py` each built their own
`httpx.AsyncClient(follow_redirects=True, timeout=30.0)`: no `User-Agent`
(so every request announced itself as `python-httpx/x.y`), no
`Accept-Language` (so locale-routed sites like LinkedIn served the wrong
variant), no retry (a single transient 503 failed the whole IngestionJob),
and no pacing (a 25-offer fan-out hit one host 25 times as fast as the event
loop allowed, which is what earns a rate-limit in the first place).

Three things live here, all of them the boring, documented kind of politeness
rather than fingerprint forgery — the honest ceiling of what in-process code
can do, with `browser_fetch` and the OFFICIAL_API adapters as the escalation
paths for sites this isn't enough for (PRD Section 14):

1. **Identifying headers** a real browser sends, so a site can serve its
   normal page and can attribute the traffic.
2. **Per-host pacing**: a minimum interval between two requests to the same
   host, serialised per host so concurrent fan-out can't bypass it.
3. **Bounded retry** with exponential backoff and jitter on transient
   failures (429/5xx/transport), honouring `Retry-After` when the site sends
   one.
"""

import asyncio
import os
import random
from collections import defaultdict
from urllib.parse import urlparse

import httpx
from py_db.structured_logging import get_logger

logger = get_logger(__name__)

# A current desktop Chrome UA. Kept overridable (`SCRAPER_USER_AGENT`) because
# the truthful thing to send varies by deployment — an operator running this
# against a site they have an agreement with may want a contact UA instead.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

# `Accept-Language` is not cosmetic: LinkedIn, Indeed and WTTJ all route on it
# (`www.linkedin.com/jobs/view/...` vs `fr.linkedin.com/...`), and the French
# variant is the one that carries the JobPosting JSON-LD block that
# docs/adr/0010's deterministic tier reads instead of paying for an LLM call.
DEFAULT_ACCEPT_LANGUAGE = "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7"

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MIN_DELAY_SECONDS = 1.0
DEFAULT_MAX_RETRIES = 3
DEFAULT_BACKOFF_BASE_SECONDS = 1.5

# Retried with backoff: transient by nature. 403/404 are *not* here — they are
# terminal for this client and `blocking.detect_block` classifies them, so
# retrying them would just multiply the block.
RETRY_STATUS_CODES = frozenset({429, 500, 502, 503, 504, 522, 524})


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def browser_headers(*, accept_language: str | None = None) -> dict[str, str]:
    """The header set a plain desktop-browser navigation sends. Omitting these
    is what makes a fetch stand out — not their presence."""
    return {
        "User-Agent": os.environ.get("SCRAPER_USER_AGENT") or DEFAULT_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": accept_language
        or os.environ.get("SCRAPER_ACCEPT_LANGUAGE")
        or DEFAULT_ACCEPT_LANGUAGE,
        # No `Accept-Encoding` on purpose. httpx sets its own from the codecs
        # it can actually decode, and overriding it with a browser's list is a
        # silent corruption bug: advertising `br` without brotli installed
        # makes servers return a brotli body httpx hands back as raw bytes.
        # `response.text` is then garbage — JSON parsing blows up, and HTML
        # parsing quietly finds zero offers, which reads exactly like selector
        # drift. Let httpx claim only what it can honour.
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Connection": "keep-alive",
    }


def make_http_client(**kwargs) -> httpx.AsyncClient:
    """The client every fetch path should use when the caller didn't inject
    one. Callers keep passing their own `http_client` in tests (respx) —
    this only changes what the *default* looks like."""
    kwargs.setdefault("headers", browser_headers())
    kwargs.setdefault("follow_redirects", True)
    kwargs.setdefault(
        "timeout",
        _env_float("SCRAPER_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS),
    )
    return httpx.AsyncClient(**kwargs)


class DomainRateLimiter:
    """Serialises requests per host and keeps at least `min_delay` seconds
    between two of them.

    Per-host, not global: a fan-out across France Travail and HelloWork
    shouldn't pay for pacing it doesn't owe either of them. The lock is held
    across the sleep so N concurrent coroutines targeting one host queue up
    instead of all reading the same stale "last request" timestamp.
    """

    def __init__(self, min_delay: float | None = None) -> None:
        self._min_delay = min_delay
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._last_request: dict[str, float] = {}

    @property
    def min_delay(self) -> float:
        if self._min_delay is not None:
            return self._min_delay
        return _env_float("SCRAPER_MIN_DELAY_SECONDS", DEFAULT_MIN_DELAY_SECONDS)

    async def acquire(self, url: str) -> None:
        delay = self.min_delay
        if delay <= 0:
            return
        host = (urlparse(url).hostname or "").lower()
        async with self._locks[host]:
            loop = asyncio.get_running_loop()
            elapsed = loop.time() - self._last_request.get(host, float("-inf"))
            if elapsed < delay:
                await asyncio.sleep(delay - elapsed)
            self._last_request[host] = loop.time()


#: Process-wide so pacing holds across every fetch a worker makes, not just
#: the ones inside a single pipeline call.
RATE_LIMITER = DomainRateLimiter()


def _retry_after_seconds(response: httpx.Response) -> float | None:
    """`Retry-After` in seconds, when the site sent a delta-seconds form. The
    HTTP-date form is ignored deliberately: it is rare here and parsing it
    wrong is worse than falling back to our own backoff."""
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, float(raw.strip()))
    except ValueError:
        return None


async def fetch(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_retries: int | None = None,
    rate_limiter: DomainRateLimiter | None = None,
    **request_kwargs,
) -> httpx.Response:
    """GET `url` with per-host pacing and bounded retry.

    Returns the final `httpx.Response` whatever its status — classifying a
    403/503 is `blocking.detect_block`'s job, not this function's. Raises
    `httpx.HTTPError` only when every attempt failed at the transport layer.
    """
    retries = (
        max_retries
        if max_retries is not None
        else _env_int("SCRAPER_MAX_RETRIES", DEFAULT_MAX_RETRIES)
    )
    limiter = rate_limiter or RATE_LIMITER
    backoff_base = _env_float(
        "SCRAPER_BACKOFF_BASE_SECONDS", DEFAULT_BACKOFF_BASE_SECONDS
    )

    last_error: httpx.HTTPError | None = None
    response: httpx.Response | None = None

    for attempt in range(retries + 1):
        await limiter.acquire(url)
        try:
            response = await client.get(url, **request_kwargs)
            last_error = None
            if response.status_code not in RETRY_STATUS_CODES:
                return response
        except httpx.HTTPError as exc:
            last_error = exc
            response = None

        if attempt == retries:
            break

        # Jitter matters: a fan-out that hits a 503 retries N offers at once,
        # and a fixed backoff would have them all come back in lockstep.
        wait = backoff_base * (2**attempt) + random.uniform(0, 0.5)
        if response is not None:
            wait = _retry_after_seconds(response) or wait
        logger.warning(
            "fetch_retry",
            extra={
                "url": url,
                "attempt": attempt + 1,
                "max_attempts": retries + 1,
                "status": response.status_code if response is not None else None,
                "error": str(last_error) if last_error else None,
                "wait_seconds": round(wait, 2),
            },
        )
        await asyncio.sleep(wait)

    if response is not None:
        return response
    raise last_error if last_error else httpx.HTTPError(f"Failed to fetch {url}")
