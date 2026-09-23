import pytest
from fastapi.testclient import TestClient

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def test_a_region_resolves_whatever_its_accents_and_case():
    # #215: the form tells the candidate before a run whether a typed
    # location was recognised.
    with TestClient(app) as client:
        response = client.get(
            "/v1/locations/resolve", params={"q": "ILE-DE-FRANCE"}, headers=HEADERS
        )
    assert response.status_code == 200
    assert response.json() == {
        "location": {"kind": "region", "code": "11", "label": "Île-de-France"}
    }


def test_an_unrecognised_location_resolves_to_null():
    with TestClient(app) as client:
        response = client.get("/v1/locations/resolve", params={"q": "Lyonn"}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"location": None}


def test_resolving_a_location_requires_internal_secret():
    client = TestClient(app)
    response = client.get("/v1/locations/resolve", params={"q": "Rhône"})
    assert response.status_code == 401
