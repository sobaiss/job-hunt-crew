"""The escalation ladder (`ingestion.fetch`).

Plain HTTP -> headless browser -> stop with a reason. The browser tier is
stubbed here: what these tests pin down is *when* the ladder climbs, which is
the decision the pipeline depends on, not Chromium's own behaviour.
"""

import pytest
import respx
from httpx import Response
from py_db.models import SiteConfig, Siteconfigsitekey

from ingestion import fetch as fetch_module
from ingestion.blocking import BlockKind
from ingestion.browser_fetch import BrowserUnavailableError
from ingestion.fetch import FetchError, fetch_page
from ingestion.http_client import make_http_client
from test_blocking import (
    AWS_WAF_CHALLENGE_HTML,
    INDEED_CAPTCHA_HTML,
    REAL_OFFER_HTML,
)

URL = "https://example.com/jobs/offer-1"


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    monkeypatch.setenv("SCRAPER_MIN_DELAY_SECONDS", "0")
    monkeypatch.setenv("SCRAPER_BACKOFF_BASE_SECONDS", "0.01")
    # conftest disables the browser tier suite-wide so no test accidentally
    # launches Chromium at a real site; this module is the one that tests the
    # escalation itself, and always stubs the browser (`_stub_browser`).
    monkeypatch.setenv("BROWSER_FETCH_ENABLED", "1")


def _site_config(*, requires_js: bool) -> SiteConfig:
    return SiteConfig(
        id="site-1",
        siteKey=Siteconfigsitekey.WTTJ,
        displayName="Test site",
        baseUrl="https://example.com",
        requiresJsRendering=requires_js,
    )


def _stub_browser(monkeypatch, result):
    """Replace the browser tier. `result` is the HTML it returns, or an
    exception instance it raises."""
    calls: list[str] = []

    async def _fake(url, **kwargs):
        calls.append(url)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(fetch_module, "fetch_rendered_html", _fake)
    return calls


@pytest.mark.asyncio
@respx.mock
async def test_plain_http_content_is_returned_without_touching_the_browser(monkeypatch):
    calls = _stub_browser(monkeypatch, "<html>browser</html>")
    respx.get(URL).mock(return_value=Response(200, text=REAL_OFFER_HTML))
    async with make_http_client() as client:
        html = await fetch_page(URL, http_client=client)
    assert "Développeur Backend JAVA" in html
    assert calls == []


@pytest.mark.asyncio
@respx.mock
async def test_browser_solvable_block_escalates_and_succeeds(monkeypatch):
    """WTTJ's shape: plain HTTP gets an AWS WAF JS challenge, the browser
    runs it and reaches the real page."""
    calls = _stub_browser(monkeypatch, REAL_OFFER_HTML)
    respx.get(URL).mock(return_value=Response(202, text=AWS_WAF_CHALLENGE_HTML))
    async with make_http_client() as client:
        html = await fetch_page(URL, http_client=client)
    assert "Développeur Backend JAVA" in html
    assert calls == [URL]


@pytest.mark.asyncio
@respx.mock
async def test_captcha_wall_never_escalates(monkeypatch):
    """Indeed's shape. Escalating would spend a Chromium launch on a wall
    #118 already proved a headless browser cannot pass."""
    calls = _stub_browser(monkeypatch, REAL_OFFER_HTML)
    respx.get(URL).mock(return_value=Response(403, text=INDEED_CAPTCHA_HTML))
    async with make_http_client() as client:
        with pytest.raises(FetchError) as excinfo:
            await fetch_page(URL, http_client=client)
    assert calls == []
    assert excinfo.value.blocked
    assert excinfo.value.detection.kind is BlockKind.CAPTCHA
    assert str(excinfo.value).startswith("BLOCKED_CAPTCHA:")


@pytest.mark.asyncio
@respx.mock
async def test_still_blocked_after_browser_reports_the_later_reason(monkeypatch):
    calls = _stub_browser(monkeypatch, INDEED_CAPTCHA_HTML)
    respx.get(URL).mock(return_value=Response(202, text=AWS_WAF_CHALLENGE_HTML))
    async with make_http_client() as client:
        with pytest.raises(FetchError) as excinfo:
            await fetch_page(URL, http_client=client)
    assert calls == [URL]
    # The browser got further and hit a *different* wall — report that one,
    # not the challenge we already cleared.
    assert excinfo.value.detection.kind is BlockKind.CAPTCHA


@pytest.mark.asyncio
@respx.mock
async def test_requires_js_rendering_starts_at_the_browser(monkeypatch):
    calls = _stub_browser(monkeypatch, REAL_OFFER_HTML)
    route = respx.get(URL).mock(return_value=Response(200, text=REAL_OFFER_HTML))
    async with make_http_client() as client:
        html = await fetch_page(
            URL, site_config=_site_config(requires_js=True), http_client=client
        )
    assert "Développeur Backend JAVA" in html
    assert calls == [URL]
    assert route.call_count == 0


@pytest.mark.asyncio
@respx.mock
async def test_missing_browser_falls_back_to_plain_http(monkeypatch):
    """A site marked `requiresJsRendering` on a deployment with no Chromium
    still gets its server-rendered markup tried — LinkedIn's guest pages
    carry enough, and a real answer beats none."""
    _stub_browser(monkeypatch, BrowserUnavailableError("playwright not installed"))
    respx.get(URL).mock(return_value=Response(200, text=REAL_OFFER_HTML))
    async with make_http_client() as client:
        html = await fetch_page(
            URL, site_config=_site_config(requires_js=True), http_client=client
        )
    assert "Développeur Backend JAVA" in html


@pytest.mark.asyncio
@respx.mock
async def test_browser_failure_preserves_the_original_block_reason(monkeypatch):
    """When rung 2 is unavailable, the caller must still learn what rung 1
    hit — not a message about Playwright."""
    _stub_browser(monkeypatch, BrowserUnavailableError("playwright not installed"))
    respx.get(URL).mock(return_value=Response(202, text=AWS_WAF_CHALLENGE_HTML))
    async with make_http_client() as client:
        with pytest.raises(FetchError) as excinfo:
            await fetch_page(URL, http_client=client)
    assert excinfo.value.detection.kind is BlockKind.AWS_WAF_CHALLENGE


@pytest.mark.asyncio
@respx.mock
async def test_disabled_browser_tier_is_not_attempted(monkeypatch):
    monkeypatch.setenv("BROWSER_FETCH_ENABLED", "0")
    calls = _stub_browser(monkeypatch, REAL_OFFER_HTML)
    respx.get(URL).mock(return_value=Response(202, text=AWS_WAF_CHALLENGE_HTML))
    async with make_http_client() as client:
        with pytest.raises(FetchError):
            await fetch_page(URL, http_client=client)
    assert calls == []


@pytest.mark.asyncio
@respx.mock
async def test_transport_failure_is_not_reported_as_a_block(monkeypatch):
    _stub_browser(monkeypatch, REAL_OFFER_HTML)
    respx.get(URL).mock(return_value=Response(404, text="<html>not found</html>"))
    async with make_http_client() as client:
        with pytest.raises(FetchError) as excinfo:
            await fetch_page(URL, http_client=client)
    assert not excinfo.value.blocked
    assert "Failed to fetch" in str(excinfo.value)
