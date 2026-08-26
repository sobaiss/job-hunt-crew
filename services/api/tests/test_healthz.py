from fastapi.testclient import TestClient

from api.main import app


def test_healthz_returns_200():
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200
