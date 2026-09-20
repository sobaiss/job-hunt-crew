"""Admin LLM providers list (issue #174, part of the #172 epic): the read-only
`GET /v1/admin/llm-provider-settings`. Nothing is stored yet, so every
provider's state is derived from the API's own environment plus the
catalogue's hardcoded defaults -- these tests drive it through the HTTP
surface with the environment patched, never the resolution internals.
"""

import pytest
from fastapi.testclient import TestClient

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}
ADMIN_HEADERS = {**HEADERS, "X-User-Role": "ADMINISTRATOR", "X-User-Id": "admin-1"}
URL = "/v1/admin/llm-provider-settings"

LLM_ENV_VARS = (
    "LLM_PROVIDER",
    "LLM_MODEL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "OLLAMA_BASE_URL",
)


@pytest.fixture(autouse=True)
def _clean_llm_env(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    for name in LLM_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def _get() -> dict:
    with TestClient(app) as client:
        response = client.get(URL, headers=ADMIN_HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def _provider(body: dict, key: str) -> dict:
    return next(p for p in body["providers"] if p["key"] == key)


def _parameter(provider: dict, name: str) -> dict:
    return next(p for p in provider["parameters"] if p["name"] == name)


def test_requires_administrator():
    with TestClient(app) as client:
        response = client.get(URL, headers={**HEADERS, "X-User-Role": "EXTERNAL", "X-User-Id": "u"})
    assert response.status_code == 403


def test_requires_a_user():
    with TestClient(app) as client:
        response = client.get(URL, headers={**HEADERS, "X-User-Role": "ADMINISTRATOR"})
    assert response.status_code == 401


def test_lists_the_five_providers_in_catalogue_order_with_maturity():
    body = _get()

    assert [(p["key"], p["displayName"], p["maturity"]) for p in body["providers"]] == [
        ("anthropic", "Anthropic", "production"),
        ("openai", "OpenAI", "production"),
        ("openrouter", "OpenRouter", "opt-in"),
        ("huggingface", "Hugging Face", "opt-in"),
        ("ollama", "Ollama", "dev-local"),
    ]


def test_nothing_stored_yet_so_no_provider_is_active_or_modified():
    body = _get()

    assert body["activeProvider"] is None
    for provider in body["providers"]:
        assert provider["active"] is False
        assert provider["settingId"] is None
        assert provider["updatedAt"] is None


def test_hosted_provider_with_no_key_in_the_environment_is_incomplete():
    body = _get()

    for key in ("anthropic", "openai", "openrouter", "huggingface"):
        provider = _provider(body, key)
        assert provider["configuration"] == "incomplete"
        api_key = _parameter(provider, "apiKey")
        assert api_key["source"] == "unresolved"
        assert api_key["required"] is True
        assert api_key["secret"] is True
        assert api_key["isSet"] is False


def test_hosted_provider_with_its_key_in_the_environment_is_inherited(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-secret-value-1234")
    monkeypatch.setenv("HF_TOKEN", "hf_secret_token_5678")

    body = _get()

    assert _provider(body, "openai")["configuration"] == "inherited"
    assert _provider(body, "huggingface")["configuration"] == "inherited"
    assert _provider(body, "anthropic")["configuration"] == "incomplete"


def test_environment_secret_is_reported_as_set_and_never_returned(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-value-9999")

    with TestClient(app) as client:
        response = client.get(URL, headers=ADMIN_HEADERS)

    assert "sk-ant-secret-value-9999" not in response.text
    assert "9999" not in response.text
    api_key = _parameter(_provider(response.json(), "anthropic"), "apiKey")
    assert api_key["source"] == "environment"
    assert api_key["isSet"] is True
    assert api_key["value"] is None


def test_ollama_has_no_required_parameter_so_it_reads_inherited():
    body = _get()

    ollama = _provider(body, "ollama")
    assert ollama["configuration"] == "inherited"
    assert [(p["name"], p["required"], p["secret"]) for p in ollama["parameters"]] == [
        ("baseUrl", False, False),
        ("model", False, False),
    ]


def test_non_secret_values_report_their_effective_value_and_source(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1")

    ollama = _provider(_get(), "ollama")

    base_url = _parameter(ollama, "baseUrl")
    assert (base_url["source"], base_url["value"]) == (
        "environment",
        "http://host.docker.internal:11434/v1",
    )
    model = _parameter(ollama, "model")
    assert (model["source"], model["value"]) == ("default", "qwen3.5:latest")


def test_empty_environment_value_falls_through_to_the_default(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "")

    base_url = _parameter(_provider(_get(), "ollama"), "baseUrl")

    assert (base_url["source"], base_url["value"]) == ("default", "http://localhost:11434/v1")


def test_llm_model_does_not_leak_into_any_provider_model(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "some-shared-model")

    body = _get()

    for provider in body["providers"]:
        assert _parameter(provider, "model")["source"] == "default"
        assert _parameter(provider, "model")["value"] != "some-shared-model"


def test_none_row_names_anthropic_when_llm_provider_is_unset():
    assert _get()["environmentProvider"] == {"key": "anthropic", "unsupportedValue": None}


def test_none_row_names_the_provider_the_environment_resolves_to(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "Ollama")

    assert _get()["environmentProvider"] == {"key": "ollama", "unsupportedValue": None}


def test_unsupported_llm_provider_is_a_marker_not_an_error(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")

    body = _get()

    assert body["environmentProvider"] == {"key": None, "unsupportedValue": "gemini"}
    assert len(body["providers"]) == 5
