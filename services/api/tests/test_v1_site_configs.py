import pytest
from fastapi.testclient import TestClient

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def test_list_site_configs_returns_seeded_enabled_sites():
    with TestClient(app) as client:
        response = client.get("/v1/site-configs", headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert "siteConfigs" in body
    site_configs = body["siteConfigs"]
    assert len(site_configs) == 6

    site_keys = {row["siteKey"] for row in site_configs}
    assert site_keys == {
        "LINKEDIN",
        "FRANCE_TRAVAIL",
        "WTTJ",
        "HELLOWORK",
        # OFFICIAL_API sources seeded as the answer to the walled sites
        # (PRD Section 14): structured responses, no anti-bot surface.
        "ADZUNA",
        "REMOTIVE",
    }
    # INDEED and GLASSDOOR are seeded but disabled — both sit behind a
    # Cloudflare CAPTCHA wall that neither a plain HTTP fetch nor the
    # headless-browser tier can clear, so they are deliberately kept out of
    # the site picker rather than offered and failing. See their seed notes.
    assert "INDEED" not in site_keys
    assert "GLASSDOOR" not in site_keys
    assert all(row["enabled"] is True for row in site_configs)

    display_names = [row["displayName"] for row in site_configs]
    assert display_names == sorted(display_names)

    france_travail = next(row for row in site_configs if row["siteKey"] == "FRANCE_TRAVAIL")
    assert france_travail["integrationType"] == "OFFICIAL_API"
    assert france_travail["displayName"] == "France Travail"
    for key in (
        "id",
        "baseUrl",
        "antiBotRiskLevel",
        "requiresJsRendering",
        "createdAt",
        "updatedAt",
    ):
        assert key in france_travail


def test_list_site_configs_requires_internal_secret():
    client = TestClient(app)
    response = client.get("/v1/site-configs")
    assert response.status_code == 401
