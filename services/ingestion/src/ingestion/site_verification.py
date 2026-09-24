"""`make verify-sites`: ask the live sites whether each Search filter is
actually honoured (#209).

Per site, one baseline search, then the same search once per probe. A probe
is either a canonical filter driven through the site's Site adapter — what a
candidate's Scout really sends today — or a raw parameter appended to the
baseline, which is how a mapping gets proved *before* an adapter is written
to use it.

The signal is a differential result count. An API source is also checked for
rejection, but a rejection alone is not enough: France Travail answers 400 to
a bad *value* (`region=Ile-de-France`) yet silently ignores an unknown
*parameter* (`travailATemps`, or anything else), returning the unfiltered
count. A scraped site never rejects anything, it returns unfiltered results.
So everywhere the question is the same: did the filter change the count?

Never run by `make test` or CI: a third party's rate limiting must not fail a
build that contains no fault. The output is read by a developer — see
docs/site-verification.md for how to read it, and the last recorded run.
"""

import asyncio
import re
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from html import unescape
from urllib.parse import parse_qsl, quote, urlencode

import httpx
from py_db.models import (
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
)

from .fetch import FetchError, fetch_page
from .france_travail import FranceTravailApiError, _get_access_token
from .http_client import fetch as http_fetch
from .http_client import make_http_client
from .search_adapters import SearchRequest, build_search_request

FRANCE_TRAVAIL_API = "https://api.francetravail.io/partenaire/offresdemploi/v2"


class Verdict(StrEnum):
    HONOURED = "honoured"
    NOT_HONOURED = "not honoured"
    COULD_NOT_TELL = "could not tell"
    EMPTY = "empty result"


@dataclass(frozen=True)
class Count:
    """A search's total result count. `at_least` when the site only states a
    floor ("Plus de 9 000") — two equal floors say nothing."""

    value: int
    at_least: bool = False

    def __str__(self) -> str:
        return f"{self.value}+" if self.at_least else str(self.value)


def judge(
    baseline: Count | None,
    filtered: Count | None,
    *,
    sent: bool,
    rejection: str | None = None,
    same_offers: bool | None = None,
) -> tuple[Verdict, str]:
    """The verdict on one probe, with the evidence behind it. `same_offers`
    says whether both searches' first pages list the very same offers, where
    the site shows offers to compare — the only tie-breaker for two equal
    capped counts."""
    if not sent:
        return Verdict.NOT_HONOURED, "the adapter sends nothing for this filter"
    if rejection:
        return Verdict.NOT_HONOURED, f"rejected: {rejection}"
    if baseline is None or filtered is None:
        return Verdict.COULD_NOT_TELL, "no result count could be read"
    evidence = f"{baseline} -> {filtered}"
    if baseline.value == 0 or filtered.value == 0:
        # Zero is a valid answer, not a failure — but it cannot tell a filter
        # applied from a value the site matched to nothing.
        return Verdict.EMPTY, evidence
    if filtered.value < baseline.value:
        return Verdict.HONOURED, evidence
    if filtered.value > baseline.value:
        # A filter never widens a search: more offers means the site answered
        # a different search — LinkedIn pads a thin one — or the listing moved
        # between the two requests.
        return Verdict.COULD_NOT_TELL, f"{evidence} (more with the filter)"
    if baseline.at_least and filtered.at_least:
        if same_offers:
            return Verdict.NOT_HONOURED, f"{evidence} (both capped, same offers)"
        return Verdict.COULD_NOT_TELL, f"{evidence} (both capped)"
    return Verdict.NOT_HONOURED, evidence


# --- Reading a count off each site ---------------------------------------


def _digits(text: str) -> int | None:
    digits = re.sub(r"\D", "", text)
    return int(digits) if digits else None


def hellowork_count(html: str) -> Count | None:
    """The results heading: `<h1>1&#x202F;030 offres</h1>`, `0 offre`."""
    match = re.search(r"<h1[^>]*>\s*([^<]*?)\s*</h1>", html)
    if not match or "offre" not in match.group(1):
        return None
    value = _digits(unescape(match.group(1)))
    return Count(value) if value is not None else None


def linkedin_count(html: str) -> Count | None:
    """The guest search header: `174`, or a floor like `Plus de 9 000`.
    LinkedIn pads a search that matches nothing with unrelated offers, so it
    never reads as zero — it reads as a floor, and a floor cannot tell."""
    match = re.search(r"results-context-header__job-count[^>]*>\s*([^<]*)<", html)
    if not match:
        return None
    text = unescape(match.group(1))
    value = _digits(text)
    if value is None:
        return None
    return Count(value, at_least=not text.strip()[0].isdigit())


def linkedin_offers(html: str) -> frozenset[str]:
    """The offers a guest search page lists, by path: every link carries
    `refId`/`trackingId` parameters that change on each request."""
    return frozenset(re.findall(r"jobs/view/[^?\"&#]+", html))


def france_travail_count(status: int, content_range: str | None) -> Count | None:
    """`204 No Content` is the API's empty result; otherwise the total sits
    after the slash of `Content-Range: offres 0-149/3285`."""
    if status == 204:
        return Count(0)
    if not content_range or "/" not in content_range:
        return None
    value = _digits(content_range.rsplit("/", 1)[1])
    return Count(value) if value is not None else None


# --- Probes --------------------------------------------------------------


@dataclass(frozen=True)
class Probe:
    """Either a canonical filter (`filter_key`, `value`) driven through the
    adapter, or `raw` parameters appended to the baseline query."""

    label: str
    filter_key: str | None = None
    value: str | tuple[str, ...] | None = None
    raw: tuple[tuple[str, str], ...] = ()


def _canonical(key: str, *values: str) -> list[Probe]:
    return [Probe(f"{key}={v}", filter_key=key, value=v) for v in values]


def _canonical_lists(key: str, *selections: tuple[str, ...]) -> list[Probe]:
    """Probes for a list-valued filter (`contractType`), one per selection."""
    return [Probe(f"{key}={','.join(s)}", filter_key=key, value=s) for s in selections]


def _raw(param: str, *values: str) -> list[Probe]:
    return [Probe(f"raw {param}={v}", raw=((param, v),)) for v in values]


CANONICAL_PROBES = [
    *_canonical("postedWithin", "24h", "7d", "14d", "30d"),
    *_canonical("remote", "onsite", "hybrid", "remote"),
    *_canonical_lists(
        "contractType",
        ("CDI",),
        ("CDI", "CDD"),
        ("INTERIM",),
        ("STAGE",),
        ("ALTERNANCE",),
        ("FREELANCE",),
    ),
    *_canonical("location", "Ile-de-France", "Rhône"),
    *_canonical("experienceLevel", "senior"),
]


@dataclass(frozen=True)
class SiteUnderTest:
    site_key: Siteconfigsitekey
    baseline: dict[str, str]
    raw_probes: list[Probe] = field(default_factory=list)
    integration_type: Siteconfigintegrationtype = Siteconfigintegrationtype.HTML_SCRAPE
    api_base_url: str | None = None

    def site_config(self) -> SiteConfig:
        # A skeleton, as in test_search_adapters: the adapter carries the
        # site's search knowledge, not the row — no database needed.
        return SiteConfig(
            id=f"verify-{self.site_key.value.lower()}",
            siteKey=self.site_key,
            displayName=self.site_key.value,
            baseUrl="https://example.com",
            integrationType=self.integration_type,
            requiresJsRendering=False,
            antiBotRiskLevel=Siteconfigantibotrisklevel.MEDIUM,
            enabled=True,
            apiBaseUrl=self.api_base_url,
        )


SITES = [
    SiteUnderTest(
        Siteconfigsitekey.FRANCE_TRAVAIL,
        baseline={"keywords": "python"},
        integration_type=Siteconfigintegrationtype.OFFICIAL_API,
        api_base_url=FRANCE_TRAVAIL_API,
        # INSEE codes: 11 is Ile-de-France, 69 is Rhône (#215).
        raw_probes=[*_raw("region", "11"), *_raw("departement", "69")],
    ),
    SiteUnderTest(
        Siteconfigsitekey.HELLOWORK,
        baseline={"keywords": "python"},
        # The facet values HelloWork's own search form submits (#213).
        raw_probes=[
            *_raw("d", "h", "d", "w", "m"),
            *_raw("t", "Complet", "Partiel", "Occasionnel", "Pas_teletravail"),
        ],
    ),
    SiteUnderTest(
        Siteconfigsitekey.LINKEDIN,
        # An empty `location=` searches worldwide, hence France; the location
        # probe then narrows France to a region. LinkedIn caps every count
        # past 1,000 ("Plus de 1 000") and pads a thin search with unrelated
        # offers, so a search big enough to be capped is the lesser evil: two
        # equal caps are settled by comparing the offers listed.
        baseline={"keywords": "django", "location": "France"},
        # `f_TPR` is now sent by the adapter, so the canonical probes cover
        # it (#212). `f_WT` is kept: it is not sent, and this is how to tell
        # whether LinkedIn ever starts honouring it on the guest page.
        raw_probes=[*_raw("f_WT", "1", "2", "3")],
    ),
]


# --- Running against the live sites --------------------------------------


@dataclass(frozen=True)
class Answer:
    count: Count | None
    rejection: str | None = None
    error: str | None = None
    offers: frozenset[str] | None = None


Fetcher = Callable[[SearchRequest], Awaitable[Answer]]


def _html_fetcher(
    site: SiteUnderTest,
    read_count: Callable[[str], Count | None],
    read_offers: Callable[[str], frozenset[str]] | None = None,
) -> Fetcher:
    config = site.site_config()

    async def fetch(request: SearchRequest) -> Answer:
        try:
            html = await fetch_page(request.url, site_config=config)
        except (FetchError, httpx.HTTPError) as exc:
            return Answer(None, error=str(exc))
        return Answer(read_count(html), offers=read_offers(html) if read_offers else None)

    return fetch


async def _france_travail_fetcher(client: httpx.AsyncClient) -> Fetcher:
    token = await _get_access_token(client)

    async def fetch(request: SearchRequest) -> Answer:
        try:
            response = await http_fetch(
                client, request.url, headers={"Authorization": f"Bearer {token}"}
            )
        except httpx.HTTPError as exc:
            return Answer(None, error=str(exc))
        if 400 <= response.status_code < 500:
            try:
                message = response.json().get("message")
            except ValueError:
                message = None
            return Answer(None, rejection=message or f"HTTP {response.status_code}")
        if response.status_code >= 500:
            return Answer(None, error=f"HTTP {response.status_code}")
        return Answer(
            france_travail_count(
                response.status_code, response.headers.get("Content-Range")
            )
        )

    return fetch


def _with_raw(request: SearchRequest, raw: tuple[tuple[str, str], ...]) -> SearchRequest:
    """The baseline with `raw` in place of any parameter of the same name —
    an HTML adapter sends every parameter, empty ones included, and a site
    reading the first of two `f_TPR`s would read the empty one."""
    base, _, query = request.url.partition("?")
    replaced = {name for name, _ in raw}
    kept = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k not in replaced]
    return SearchRequest(f"{base}?{urlencode([*kept, *raw], quote_via=quote)}")


def _probe_request(site: SiteUnderTest, probe: Probe, baseline: SearchRequest) -> SearchRequest:
    if probe.raw:
        return _with_raw(baseline, probe.raw)
    value = list(probe.value) if isinstance(probe.value, tuple) else probe.value
    filters = {**site.baseline, probe.filter_key: value}
    return build_search_request(site.site_config(), filters)


@dataclass(frozen=True)
class Outcome:
    site_key: Siteconfigsitekey
    probe: str
    verdict: Verdict
    detail: str


async def verify_site(site: SiteUnderTest, fetch: Fetcher) -> list[Outcome]:
    baseline_request = build_search_request(site.site_config(), site.baseline)
    baseline = await fetch(baseline_request)
    outcomes = []
    for probe in [*CANONICAL_PROBES, *site.raw_probes]:
        request = _probe_request(site, probe, baseline_request)
        sent = request.url != baseline_request.url
        answer = await fetch(request) if sent else Answer(None)
        if answer.error or (sent and baseline.error):
            verdict, detail = Verdict.COULD_NOT_TELL, answer.error or baseline.error
        else:
            same_offers = (
                answer.offers == baseline.offers if answer.offers and baseline.offers else None
            )
            verdict, detail = judge(
                baseline.count,
                answer.count,
                sent=sent,
                rejection=answer.rejection,
                same_offers=same_offers,
            )
        outcomes.append(Outcome(site.site_key, probe.label, verdict, detail))
    return outcomes


def _print(outcomes: list[Outcome]) -> None:
    for o in outcomes:
        print(f"{o.site_key.value:<16} {o.probe:<28} {o.verdict.value:<15} {o.detail}")
    sys.stdout.flush()


async def main(site_keys: list[str]) -> None:
    """Every site, or only those named: `make verify-sites SITES=LINKEDIN`."""
    sites = [s for s in SITES if not site_keys or s.site_key.value in site_keys]
    async with make_http_client() as api_client:
        for site in sites:
            if site.site_key is Siteconfigsitekey.FRANCE_TRAVAIL:
                try:
                    fetcher = await _france_travail_fetcher(api_client)
                except FranceTravailApiError as exc:
                    print(f"{site.site_key.value:<16} skipped: {exc}")
                    continue
            elif site.site_key is Siteconfigsitekey.HELLOWORK:
                fetcher = _html_fetcher(site, hellowork_count)
            else:
                fetcher = _html_fetcher(site, linkedin_count, linkedin_offers)
            _print(await verify_site(site, fetcher))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
