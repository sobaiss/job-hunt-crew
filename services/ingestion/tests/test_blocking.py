"""Block detection (`ingestion.blocking`).

The fixtures below are shortened captures of what the real sites returned
during the live probe that motivated this module, so a future change to the
signature list is checked against what those pages actually contain rather
than against invented markup.
"""

from ingestion.blocking import BlockKind, detect_block

# fr.indeed.com/jobs?... answered 403 with this page — for the default
# python-httpx UA *and* for full browser headers alike.
INDEED_CAPTCHA_HTML = """
<!DOCTYPE html><html><head><title>Security Check - Indeed.com</title></head>
<body><div id="cf-wrapper"><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/captcha/v1"></script>
<div class="cf-captcha-container">CLOUDFLARE</div></div></body></html>
"""

CLOUDFLARE_JS_CHALLENGE_HTML = """
<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta name="robots" content="noindex,nofollow"></head>
<body><div class="main-wrapper"><div id="cf-please-wait"></div></div></body></html>
"""

AWS_WAF_CHALLENGE_HTML = """
<!DOCTYPE html><html><head><script src="https://de5282c3ca0c.token.awswaf.com/de5282c3ca0c/challenge.js"></script>
</head><body></body></html>
"""

REAL_OFFER_HTML = """
<!DOCTYPE html><html><head><title>Développeur Backend JAVA (F/H) chez Dassault Systèmes</title>
<script type="application/ld+json">{"@type":"JobPosting","title":"Développeur Backend JAVA"}</script>
</head><body><h1>Développeur Backend JAVA (F/H)</h1></body></html>
"""


def test_indeed_captcha_page_is_not_browser_solvable():
    detection = detect_block(
        status_code=403, html=INDEED_CAPTCHA_HTML, url="https://fr.indeed.com/jobs"
    )
    assert detection is not None
    assert detection.kind is BlockKind.CAPTCHA
    # The whole point of the flag: escalating to a headless browser here
    # would burn a Chromium launch on a wall it cannot pass (#118).
    assert detection.browser_solvable is False
    assert detection.error_message.startswith("BLOCKED_CAPTCHA:")


def test_cloudflare_js_challenge_is_browser_solvable():
    detection = detect_block(status_code=503, html=CLOUDFLARE_JS_CHALLENGE_HTML)
    assert detection is not None
    assert detection.kind is BlockKind.CLOUDFLARE_CHALLENGE
    assert detection.browser_solvable is True


def test_aws_waf_challenge_is_browser_solvable():
    """WTTJ's case: a JS challenge with no CAPTCHA step, which issue #118
    confirmed a headless browser gets through."""
    detection = detect_block(status_code=202, html=AWS_WAF_CHALLENGE_HTML)
    assert detection is not None
    assert detection.kind is BlockKind.AWS_WAF_CHALLENGE
    assert detection.browser_solvable is True


def test_captcha_wins_over_cloudflare_signature():
    """A Cloudflare *captcha* page carries both vendors' markers. Reporting it
    as the plain JS challenge would make the pipeline escalate into a wall,
    so the captcha signature has to be matched first."""
    html = CLOUDFLARE_JS_CHALLENGE_HTML + '<div class="g-recaptcha"></div>'
    detection = detect_block(status_code=403, html=html)
    assert detection is not None
    assert detection.kind is BlockKind.CAPTCHA
    assert detection.browser_solvable is False


def test_linkedin_999_is_reported_as_access_denied():
    detection = detect_block(status_code=999, html="")
    assert detection is not None
    assert detection.kind is BlockKind.ACCESS_DENIED
    # Reputation-based: a browser on the same egress IP gets the same answer.
    assert detection.browser_solvable is False


def test_rate_limit_surfaces_retry_after():
    detection = detect_block(status_code=429, html="", retry_after="120")
    assert detection is not None
    assert detection.kind is BlockKind.RATE_LIMITED
    assert "120" in detection.error_message


def test_real_offer_page_is_not_a_block():
    assert detect_block(status_code=200, html=REAL_OFFER_HTML) is None


def test_offer_mentioning_a_vendor_in_its_body_is_not_a_block():
    """A posting whose *description* names one of these products must not be
    mistaken for an interstitial — the reason only the head of the document
    is scanned."""
    html = (
        REAL_OFFER_HTML
        + "<p>"
        + ("filler " * 9_000)
        + "Experience with Cloudflare and hCaptcha.com</p>"
    )
    assert detect_block(status_code=200, html=html) is None


def test_unrecognised_403_is_browser_solvable():
    """No known signature and a 403: worth one browser attempt, since a
    server-side bot rule may simply be rejecting a non-browser client."""
    detection = detect_block(status_code=403, html="<html><body>nope</body></html>")
    assert detection is not None
    assert detection.kind is BlockKind.ACCESS_DENIED
    assert detection.browser_solvable is True
