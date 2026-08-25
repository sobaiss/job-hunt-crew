import pytest
from py_db.models import (
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)

from ingestion.site_adapters import SiteAdapterConfigError, extract_offer_urls_via_site_config

BASE = "https://example.com"


def _site_config(
    *,
    site_key: Siteconfigsitekey,
    list_item_selector: str | None,
    offer_link_selector: str | None,
    offer_title_selector: str | None,
) -> SiteConfig:
    return SiteConfig(
        id=f"site-{site_key.value.lower()}",
        siteKey=site_key,
        displayName=site_key.value,
        baseUrl=BASE,
        listItemSelector=list_item_selector,
        offerLinkSelector=offer_link_selector,
        offerTitleSelector=offer_title_selector,
        integrationType=Siteconfigintegrationtype.HTML_SCRAPE,
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.MEDIUM,
        enabled=True,
    )


def _linkedin_site_config() -> SiteConfig:
    # Mirrors packages/prisma/prisma/seed.js's LINKEDIN row.
    return _site_config(
        site_key=Siteconfigsitekey.LINKEDIN,
        list_item_selector="ul.jobs-search__results-list > li",
        offer_link_selector="a.base-card__full-link",
        offer_title_selector="h3.base-search-card__title",
    )


def _indeed_site_config() -> SiteConfig:
    # Mirrors packages/prisma/prisma/seed.js's INDEED row.
    return _site_config(
        site_key=Siteconfigsitekey.INDEED,
        list_item_selector="div.job_seen_beacon",
        offer_link_selector="a.jcs-JobTitle",
        offer_title_selector="span[title]",
    )


def _wttj_site_config() -> SiteConfig:
    # Mirrors packages/prisma/prisma/seed.js's WTTJ row.
    return _site_config(
        site_key=Siteconfigsitekey.WTTJ,
        list_item_selector="li[data-testid='search-results-list-item-wrapper']",
        offer_link_selector="a[data-testid='job-card-link']",
        offer_title_selector="h4",
    )


def _glassdoor_site_config() -> SiteConfig:
    # Mirrors packages/prisma/prisma/seed.js's GLASSDOOR row.
    return _site_config(
        site_key=Siteconfigsitekey.GLASSDOOR,
        list_item_selector="li.react-job-listing",
        offer_link_selector="a.jobLink",
        offer_title_selector="a.jobLink",
    )


def _linkedin_fixture_html(n: int) -> str:
    items = "".join(
        f'<li><a class="base-card__full-link" href="/jobs/view/{i}">'
        f'<h3 class="base-search-card__title">Job {i}</h3></a></li>'
        for i in range(n)
    )
    return f'<html><body><ul class="jobs-search__results-list">{items}</ul></body></html>'


def _indeed_fixture_html(n: int) -> str:
    items = "".join(
        f'<div class="job_seen_beacon"><a class="jcs-JobTitle" href="/rc/clk?jk={i}">'
        f'<span title="Job {i}">Job {i}</span></a></div>'
        for i in range(n)
    )
    return f"<html><body>{items}</body></html>"


def _wttj_fixture_html(n: int) -> str:
    items = "".join(
        f'<li data-testid="search-results-list-item-wrapper">'
        f'<a data-testid="job-card-link" href="/fr/companies/acme/jobs/{i}"><h4>Job {i}</h4></a></li>'
        for i in range(n)
    )
    return f"<html><body>{items}</body></html>"


def _glassdoor_fixture_html(n: int) -> str:
    items = "".join(
        f'<li class="react-job-listing"><a class="jobLink" href="/job-listing/job-{i}">Job {i}</a></li>'
        for i in range(n)
    )
    return f"<html><body>{items}</body></html>"


@pytest.mark.parametrize(
    ("site_config_factory", "fixture_factory", "expected_path_template"),
    [
        (_linkedin_site_config, _linkedin_fixture_html, "/jobs/view/{i}"),
        (_indeed_site_config, _indeed_fixture_html, "/rc/clk?jk={i}"),
        (_wttj_site_config, _wttj_fixture_html, "/fr/companies/acme/jobs/{i}"),
        (_glassdoor_site_config, _glassdoor_fixture_html, "/job-listing/job-{i}"),
    ],
    ids=["linkedin", "indeed", "wttj", "glassdoor"],
)
def test_extract_offer_urls_via_site_config_finds_five_offer_links(
    site_config_factory, fixture_factory, expected_path_template
):
    html = fixture_factory(5)

    urls = extract_offer_urls_via_site_config(html, BASE, site_config_factory())

    assert urls == [f"{BASE}{expected_path_template.format(i=i)}" for i in range(5)]


def test_extract_offer_urls_via_site_config_skips_cards_missing_the_link_selector():
    # A 6th LinkedIn-shaped card with no anchor at all (selector drift on one
    # card, per PRD Section 14) must not raise or abort the rest of the page.
    html = _linkedin_fixture_html(5).replace(
        "</ul>", '<li><h3 class="base-search-card__title">No link here</h3></li></ul>'
    )

    urls = extract_offer_urls_via_site_config(html, BASE, _linkedin_site_config())

    assert urls == [f"{BASE}/jobs/view/{i}" for i in range(5)]


def test_extract_offer_urls_via_site_config_dedupes_repeated_hrefs():
    html = (
        '<html><body><div class="job_seen_beacon">'
        '<a class="jcs-JobTitle" href="/rc/clk?jk=1"><span title="Job 1">Job 1</span></a>'
        "</div>"
        '<div class="job_seen_beacon">'
        '<a class="jcs-JobTitle" href="/rc/clk?jk=1"><span title="Job 1 dup">Job 1 dup</span></a>'
        "</div></body></html>"
    )

    urls = extract_offer_urls_via_site_config(html, BASE, _indeed_site_config())

    assert urls == [f"{BASE}/rc/clk?jk=1"]


def test_extract_offer_urls_via_site_config_requires_list_item_and_link_selectors():
    site_config = _indeed_site_config()
    site_config.listItemSelector = None

    with pytest.raises(SiteAdapterConfigError):
        extract_offer_urls_via_site_config("<html></html>", BASE, site_config)
