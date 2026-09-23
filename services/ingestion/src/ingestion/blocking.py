"""Anti-bot block detection (PRD Section 14).

The scrape/listing fetch paths used to treat any non-exception response as
real page content. That loses the one distinction the pipeline actually needs
to act on: an anti-bot vendor's interstitial is *not* an offer page, and the
two failure modes it comes in call for opposite responses.

- A **JS-execution challenge** (Cloudflare's "Just a moment...", AWS WAF's
  `token.awswaf.com` challenge) is solvable unattended: a headless browser
  runs the script, gets the clearance cookie, and reaches the real page.
  `browser_solvable=True` — `fetch.py` escalates to `browser_fetch`.
- A **CAPTCHA wall** (Indeed's "Security Check", Glassdoor's Cloudflare
  captcha) is an interactive challenge no headless browser solves on its own.
  `browser_solvable=False` — escalating is pure latency, so `fetch.py` fails
  fast with a reason an operator can act on.

That split is the same one issue #118 recorded by hand when live captures for
the per-site regression fixtures reached WTTJ but not Indeed/Glassdoor; this
module makes it something the pipeline computes at runtime instead of a
comment.

Detections surface as an `errorMessage` carrying a stable machine-readable
`BLOCKED_<KIND>:` prefix, in the same spirit as
`single_url_pipeline.LISTING_PAGE_DETECTED` — so the web layer and the
ingestion-job drill-down can tell "the site blocked us" apart from "the
selectors drifted", which the generic "No offers found; the site may be
blocking requests or its HTML structure may have changed" message cannot.
"""

from dataclasses import dataclass
from enum import Enum

# Only the first slice of a response body is scanned: every signature below
# lives in the <head> or the opening <body> of an interstitial, which is a
# small document, while a real offer page can be 300kB+. Scanning the whole
# thing would also risk a false positive on an offer whose *description* text
# happens to mention a vendor name.
_SCAN_CHARS = 40_000


class BlockKind(str, Enum):
    """Why a fetch didn't return real content. The value doubles as the
    `BLOCKED_<KIND>:` error-message prefix."""

    CLOUDFLARE_CHALLENGE = "CLOUDFLARE_CHALLENGE"
    AWS_WAF_CHALLENGE = "AWS_WAF_CHALLENGE"
    DATADOME = "DATADOME"
    PERIMETERX = "PERIMETERX"
    IMPERVA = "IMPERVA"
    CAPTCHA = "CAPTCHA"
    LOGIN_WALL = "LOGIN_WALL"
    RATE_LIMITED = "RATE_LIMITED"
    ACCESS_DENIED = "ACCESS_DENIED"


@dataclass(frozen=True)
class BlockDetection:
    kind: BlockKind
    #: Whether rendering the URL in a headless browser plausibly gets past
    #: this. True for pure JS-execution challenges, False for anything
    #: needing a human (CAPTCHA) or credentials (login wall).
    browser_solvable: bool
    detail: str

    @property
    def error_message(self) -> str:
        return f"BLOCKED_{self.kind.value}: {self.detail}"


@dataclass(frozen=True)
class _Signature:
    kind: BlockKind
    browser_solvable: bool
    detail: str
    #: Lowercased substrings; any one matching the scanned body is a hit.
    markers: tuple[str, ...]


# Ordered most-specific first: a Cloudflare CAPTCHA page carries Cloudflare's
# own markers *and* a captcha widget, and must be reported as the CAPTCHA
# (not browser-solvable) rather than as the plain JS challenge, so the
# captcha signatures are matched before the vendor-challenge ones.
_SIGNATURES: tuple[_Signature, ...] = (
    _Signature(
        kind=BlockKind.CAPTCHA,
        browser_solvable=False,
        detail="the page is an interactive CAPTCHA wall, which no unattended "
        "headless browser can solve",
        markers=(
            "g-recaptcha",
            "hcaptcha.com",
            "h-captcha",
            "recaptcha/api.js",
            "geo.captcha-delivery.com",
            "px-captcha",
            "security check",
            "additional verification",
            "verifying you are human",
        ),
    ),
    _Signature(
        kind=BlockKind.DATADOME,
        browser_solvable=False,
        detail="blocked by DataDome",
        markers=("datadome", "dd_cookie_test"),
    ),
    _Signature(
        kind=BlockKind.PERIMETERX,
        browser_solvable=False,
        detail="blocked by PerimeterX/HUMAN",
        markers=("perimeterx", "_pxhd", "px-cloud.net"),
    ),
    _Signature(
        kind=BlockKind.IMPERVA,
        browser_solvable=False,
        detail="blocked by Imperva/Incapsula",
        markers=("incapsula incident id", "_incapsula_resource"),
    ),
    _Signature(
        kind=BlockKind.CLOUDFLARE_CHALLENGE,
        browser_solvable=True,
        detail="Cloudflare JS challenge — retryable with a headless browser",
        markers=(
            "/cdn-cgi/challenge-platform",
            "just a moment",
            "cf-chl",
            "checking your browser before accessing",
            "attention required! | cloudflare",
        ),
    ),
    _Signature(
        kind=BlockKind.AWS_WAF_CHALLENGE,
        browser_solvable=True,
        detail="AWS WAF JS challenge — retryable with a headless browser",
        markers=("token.awswaf.com", "awswaf", "aws-waf-token"),
    ),
    _Signature(
        kind=BlockKind.LOGIN_WALL,
        browser_solvable=False,
        detail="the site served a sign-in wall instead of the content",
        markers=("/authwall", "authwall?", "please sign in to continue"),
    ),
)


def detect_block(
    *, status_code: int, html: str, url: str = "", retry_after: str | None = None
) -> BlockDetection | None:
    """The `BlockDetection` for a fetched response, or `None` when it looks
    like real content.

    Status code first (a 429/403 is a block whatever the body says), then
    body signatures — an interstitial is routinely served with `200 OK`,
    which is exactly the case the old code stored in S3 as a successful
    scrape and only noticed one stage later as a missing title (docs/adr/0010).
    """
    body = html[:_SCAN_CHARS].lower()

    if status_code == 429:
        suffix = f" (Retry-After: {retry_after})" if retry_after else ""
        return BlockDetection(
            kind=BlockKind.RATE_LIMITED,
            browser_solvable=False,
            detail=f"the site rate-limited this client (HTTP 429){suffix}",
        )

    # LinkedIn's non-standard "request denied" status. It is purely
    # reputation-based (datacenter IP, request volume), so a browser on the
    # same IP gets the same answer — escalating would only burn time.
    if status_code == 999:
        return BlockDetection(
            kind=BlockKind.ACCESS_DENIED,
            browser_solvable=False,
            detail="LinkedIn returned HTTP 999 (request denied — usually IP "
            "reputation or request volume, not headers)",
        )

    for signature in _SIGNATURES:
        if any(marker in body for marker in signature.markers):
            return BlockDetection(
                kind=signature.kind,
                browser_solvable=signature.browser_solvable,
                detail=f"{signature.detail} [{url or 'page'}]",
            )

    if status_code in (401, 403):
        return BlockDetection(
            kind=BlockKind.ACCESS_DENIED,
            browser_solvable=True,
            detail=f"the site refused the request (HTTP {status_code}) with no "
            "recognised anti-bot signature",
        )

    return None
