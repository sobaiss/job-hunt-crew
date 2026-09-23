import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/job_hunt_crew?schema=public",
)
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("S3_REGION", "us-east-1")
os.environ.setdefault("S3_BUCKET", "job-hunt-crew")
os.environ.setdefault("S3_FORCE_PATH_STYLE", "true")
os.environ.setdefault("S3_ACCESS_KEY_ID", "minioadmin")
os.environ.setdefault("S3_SECRET_ACCESS_KEY", "minioadmin")

# The headless-browser escalation tier is off by default under test. respx
# mocks httpx, not Chromium, so a test that mocks a blocked response would
# otherwise have `fetch.fetch_page` escalate into a *real* browser making a
# *real* request to the site — network-dependent, slow, and a different code
# path than the one under test. Tests that exercise escalation turn it back on
# and stub the browser (see test_fetch.py).
os.environ.setdefault("BROWSER_FETCH_ENABLED", "0")
# Per-host pacing is production politeness; in tests it only adds wall-clock.
os.environ.setdefault("SCRAPER_MIN_DELAY_SECONDS", "0")
