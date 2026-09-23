"""Pacing and retry (`ingestion.http_client`)."""

import asyncio

import httpx
import pytest
import respx
from httpx import Response

from ingestion.http_client import (
    DomainRateLimiter,
    browser_headers,
    fetch,
    make_http_client,
)


def test_browser_headers_identify_a_browser_and_a_locale():
    headers = browser_headers()
    assert "Mozilla/5.0" in headers["User-Agent"]
    # Not cosmetic: LinkedIn locale-routes on this, and the French variant is
    # the one whose offer pages carry JobPosting JSON-LD (docs/adr/0010).
    assert headers["Accept-Language"].startswith("fr-FR")


def test_headers_do_not_claim_an_encoding_we_cannot_decode():
    """Regression: hardcoding a browser's `Accept-Encoding: gzip, deflate, br`
    made servers return brotli bodies httpx couldn't decode, so `response.text`
    was raw compressed bytes. Remotive's JSON raised UnicodeDecodeError and
    HelloWork's HTML silently parsed to zero offers — indistinguishable from
    selector drift. httpx must be left to advertise its own codecs."""
    assert "Accept-Encoding" not in browser_headers()


def test_user_agent_is_overridable(monkeypatch):
    monkeypatch.setenv("SCRAPER_USER_AGENT", "job-hunt-crew/1.0 (contact@example.com)")
    assert browser_headers()["User-Agent"] == "job-hunt-crew/1.0 (contact@example.com)"


@pytest.mark.asyncio
async def test_make_http_client_sets_headers_and_follows_redirects():
    async with make_http_client() as client:
        assert client.follow_redirects is True
        assert "Mozilla/5.0" in client.headers["user-agent"]


@pytest.mark.asyncio
async def test_rate_limiter_spaces_requests_to_one_host():
    limiter = DomainRateLimiter(min_delay=0.05)
    loop = asyncio.get_running_loop()
    start = loop.time()
    for _ in range(3):
        await limiter.acquire("https://example.com/a")
    # First call is free; the next two each wait one interval.
    assert loop.time() - start >= 0.09


@pytest.mark.asyncio
async def test_rate_limiter_does_not_penalise_a_different_host():
    limiter = DomainRateLimiter(min_delay=0.2)
    loop = asyncio.get_running_loop()
    start = loop.time()
    await limiter.acquire("https://a.example/1")
    await limiter.acquire("https://b.example/1")
    assert loop.time() - start < 0.2


@pytest.mark.asyncio
async def test_rate_limiter_serialises_concurrent_requests_to_one_host():
    """The lock is held across the sleep on purpose: without it, N coroutines
    launched together all read the same stale timestamp and none of them
    waits — which is precisely the burst that earns a rate-limit."""
    limiter = DomainRateLimiter(min_delay=0.05)
    loop = asyncio.get_running_loop()
    start = loop.time()
    await asyncio.gather(*(limiter.acquire("https://example.com/x") for _ in range(3)))
    assert loop.time() - start >= 0.09


@pytest.mark.asyncio
@respx.mock
async def test_fetch_retries_a_503_then_succeeds(monkeypatch):
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")
    monkeypatch.setenv("SCRAPER_BACKOFF_BASE_SECONDS", "0.01")
    route = respx.get("https://example.com/offer").mock(
        side_effect=[
            Response(503, text="upstream down"),
            Response(200, text="<html>ok</html>"),
        ]
    )
    async with make_http_client() as client:
        response = await fetch(client, "https://example.com/offer")
    assert response.status_code == 200
    assert route.call_count == 2


@pytest.mark.asyncio
@respx.mock
async def test_fetch_gives_up_after_max_retries(monkeypatch):
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")
    monkeypatch.setenv("SCRAPER_BACKOFF_BASE_SECONDS", "0.01")
    route = respx.get("https://example.com/offer").mock(
        return_value=Response(503, text="still down")
    )
    async with make_http_client() as client:
        response = await fetch(client, "https://example.com/offer", max_retries=2)
    # Returned, not raised: classifying a status is `blocking.detect_block`'s
    # job, so `fetch` hands the final response back whatever it says.
    assert response.status_code == 503
    assert route.call_count == 3


@pytest.mark.asyncio
@respx.mock
async def test_fetch_does_not_retry_a_403(monkeypatch):
    """A 403 is terminal for this client — retrying only multiplies the
    block. `detect_block` decides what it means."""
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")
    route = respx.get("https://example.com/offer").mock(
        return_value=Response(403, text="denied")
    )
    async with make_http_client() as client:
        response = await fetch(client, "https://example.com/offer")
    assert response.status_code == 403
    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_fetch_honours_retry_after(monkeypatch):
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")
    monkeypatch.setenv("SCRAPER_BACKOFF_BASE_SECONDS", "10")
    respx.get("https://example.com/offer").mock(
        side_effect=[
            Response(429, headers={"Retry-After": "0.01"}, text=""),
            Response(200, text="<html>ok</html>"),
        ]
    )
    loop = asyncio.get_running_loop()
    start = loop.time()
    async with make_http_client() as client:
        response = await fetch(client, "https://example.com/offer")
    # Retry-After (0.01s) overrides the 10s backoff base, not the other way round.
    assert response.status_code == 200
    assert loop.time() - start < 5


@pytest.mark.asyncio
@respx.mock
async def test_fetch_raises_when_every_attempt_fails_at_transport(monkeypatch):
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")
    monkeypatch.setenv("SCRAPER_BACKOFF_BASE_SECONDS", "0.01")
    respx.get("https://example.com/offer").mock(
        side_effect=httpx.ConnectError("no route to host")
    )
    async with make_http_client() as client:
        with pytest.raises(httpx.HTTPError):
            await fetch(client, "https://example.com/offer", max_retries=1)
