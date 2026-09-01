import pytest
import respx
from httpx import Response

from ingestion.listing import extract_offer_urls, fetch_listing_pages, looks_like_listing

BASE = "https://example.com/jobs"


def _page_url(page: int) -> str:
    return BASE if page == 1 else f"{BASE}/page-{page}"


def _page_html(page: int, *, has_next: bool) -> str:
    next_link = f'<a rel="next" href="{_page_url(page + 1)}">Next</a>' if has_next else ""
    return f"<html><body><h1>Listing page {page}</h1>{next_link}</body></html>"


@pytest.mark.asyncio
async def test_fetch_listing_pages_caps_at_default_max_pages():
    with respx.mock(assert_all_called=False) as mock:
        mock.get(_page_url(1)).mock(return_value=Response(200, text=_page_html(1, has_next=True)))
        mock.get(_page_url(2)).mock(return_value=Response(200, text=_page_html(2, has_next=True)))
        mock.get(_page_url(3)).mock(return_value=Response(200, text=_page_html(3, has_next=True)))
        mock.get(_page_url(4)).mock(return_value=Response(200, text=_page_html(4, has_next=True)))
        mock.get(_page_url(5)).mock(return_value=Response(200, text=_page_html(5, has_next=False)))

        pages = await fetch_listing_pages(BASE)

        assert len(pages) == 3
        assert "Listing page 1" in pages[0]
        assert "Listing page 2" in pages[1]
        assert "Listing page 3" in pages[2]
        # Pagination cap: pages 4 and 5 must never be requested.
        assert mock.calls.call_count == 3


@pytest.mark.asyncio
async def test_fetch_listing_pages_stops_early_when_no_next_link():
    with respx.mock(assert_all_called=True) as mock:
        mock.get(_page_url(1)).mock(return_value=Response(200, text=_page_html(1, has_next=True)))
        mock.get(_page_url(2)).mock(return_value=Response(200, text=_page_html(2, has_next=False)))

        pages = await fetch_listing_pages(BASE)

        assert len(pages) == 2
        assert mock.calls.call_count == 2


@pytest.mark.asyncio
async def test_fetch_listing_pages_respects_custom_max_pages():
    with respx.mock(assert_all_called=False) as mock:
        mock.get(_page_url(1)).mock(return_value=Response(200, text=_page_html(1, has_next=True)))
        mock.get(_page_url(2)).mock(return_value=Response(200, text=_page_html(2, has_next=True)))

        pages = await fetch_listing_pages(BASE, max_pages=1)

        assert len(pages) == 1
        assert mock.calls.call_count == 1


def _card_listing_html(offer_paths: list[str]) -> str:
    cards = "".join(
        f'<div class="job-card"><a class="job-card-link" href="{path}">Title {i}</a></div>'
        for i, path in enumerate(offer_paths)
    )
    return (
        "<html><body>"
        '<nav><a class="nav-link" href="/about">About</a>'
        '<a class="nav-link" href="/contact">Contact</a></nav>'
        f"<div class='results'>{cards}</div>"
        '<footer><a href="/terms">Terms</a></footer>'
        "</body></html>"
    )


def test_extract_offer_urls_finds_five_offer_links():
    html = _card_listing_html([f"/jobs/{i}" for i in range(5)])

    urls = extract_offer_urls(html, BASE)

    assert urls == [f"https://example.com/jobs/{i}" for i in range(5)]


def test_extract_offer_urls_ignores_lone_nav_and_footer_links():
    html = _card_listing_html(["/jobs/1", "/jobs/2", "/jobs/3"])

    urls = extract_offer_urls(html, BASE)

    assert "https://example.com/about" not in urls
    assert "https://example.com/contact" not in urls
    assert "https://example.com/terms" not in urls
    assert urls == [
        "https://example.com/jobs/1",
        "https://example.com/jobs/2",
        "https://example.com/jobs/3",
    ]


def test_extract_offer_urls_dedupes_and_resolves_relative_urls():
    html = (
        "<html><body>"
        '<div><a class="job-card-link" href="/jobs/1">A</a></div>'
        '<div><a class="job-card-link" href="/jobs/2">B</a></div>'
        '<div><a class="job-card-link" href="/jobs/1">A again</a></div>'
        "</body></html>"
    )

    urls = extract_offer_urls(html, BASE)

    assert urls == ["https://example.com/jobs/1", "https://example.com/jobs/2"]


def test_extract_offer_urls_returns_empty_list_when_no_repeated_pattern():
    html = '<html><body><a href="/only-link">Solo</a></body></html>'

    urls = extract_offer_urls(html, BASE)

    assert urls == []


def test_looks_like_listing_true_for_a_page_full_of_repeated_offer_cards():
    html = _card_listing_html([f"/jobs/{i}" for i in range(12)])

    assert looks_like_listing(html, BASE) is True


def test_looks_like_listing_false_for_a_single_offer_page():
    html = (
        "<html><body>"
        "<h1>Senior Backend Engineer</h1>"
        "<p>We are hiring a backend engineer.</p>"
        '<a class="apply" href="/apply">Apply now</a>'
        '<div class="related"><a class="rel" href="/jobs/1">A related role</a>'
        '<a class="rel" href="/jobs/2">Another related role</a></div>'
        "</body></html>"
    )

    assert looks_like_listing(html, BASE) is False


def test_looks_like_listing_false_for_an_empty_page():
    assert looks_like_listing("<html><body><h1>Role</h1></body></html>", BASE) is False
