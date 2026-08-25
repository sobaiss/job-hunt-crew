import pytest
import respx
from httpx import Response

from ingestion.listing import fetch_listing_pages

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
