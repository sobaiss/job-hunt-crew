from fastapi.testclient import TestClient

from api.main import app


@app.get("/_test-stub")
async def _stub() -> dict[str, bool]:
    return {"ok": True}


def test_missing_header_returns_401(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    client = TestClient(app)
    response = client.get("/_test-stub")
    assert response.status_code == 401


def test_wrong_header_value_returns_401(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    client = TestClient(app)
    response = client.get("/_test-stub", headers={"X-Internal-Api-Secret": "wrong"})
    assert response.status_code == 401


def test_correct_header_returns_200(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    client = TestClient(app)
    response = client.get("/_test-stub", headers={"X-Internal-Api-Secret": "test-secret"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_healthz_bypasses_secret_check(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200


def test_unset_secret_env_rejects_even_with_a_header(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    client = TestClient(app)
    response = client.get("/_test-stub", headers={"X-Internal-Api-Secret": "anything"})
    assert response.status_code == 401


def test_docs_paths_bypass_secret_when_environment_is_development(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    monkeypatch.setenv("ENVIRONMENT", "development")
    client = TestClient(app)
    for path in ("/docs", "/redoc", "/openapi.json"):
        response = client.get(path)
        assert response.status_code == 200, path


def test_docs_paths_still_require_secret_when_environment_unset(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    client = TestClient(app)
    for path in ("/docs", "/redoc", "/openapi.json"):
        response = client.get(path)
        assert response.status_code == 401, path


def test_docs_paths_still_require_secret_when_environment_is_production(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    monkeypatch.setenv("ENVIRONMENT", "production")
    client = TestClient(app)
    response = client.get("/docs")
    assert response.status_code == 401
