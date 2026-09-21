"""Admin LLM providers (issues #174/#175, part of the #172 epic): the list
`GET /v1/admin/llm-provider-settings` and the non-secret save
`PUT /v1/admin/llm-provider-settings/{providerKey}`. Each provider's state is
derived from what is stored, the API's own environment and the catalogue's
hardcoded defaults -- these tests drive it through the HTTP surface with the
environment patched and real Postgres behind it, never the resolution
internals.
"""

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import AdminAuditEvent, LLMProviderSetting, Role, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

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


def _run(coro_fn):
    async def go():
        engine = make_engine()
        try:
            async with make_session_factory(engine)() as session:
                return await coro_fn(session)
        finally:
            await engine.dispose()

    return asyncio.run(go())


async def _wipe_settings(session) -> None:
    # Values cascade with their setting.
    await session.execute(delete(LLMProviderSetting))
    await session.commit()


@pytest.fixture(autouse=True)
def _clean_llm_env(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    for name in LLM_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    _run(_wipe_settings)
    yield
    _run(_wipe_settings)


@pytest.fixture
def admin():
    """A real Administrator (audit events reference their actor), and headers
    acting as them."""
    user_id = str(uuid.uuid4())

    async def create(session):
        session.add(
            User(
                id=user_id,
                email=f"{user_id}@example.com",
                role=Role.ADMINISTRATOR,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()

    async def delete_user(session):
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()

    _run(create)
    yield {**HEADERS, "X-User-Role": "ADMINISTRATOR", "X-User-Id": user_id}
    _run(delete_user)


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


# --- PUT /v1/admin/llm-provider-settings/{providerKey} (issue #175) ---


def _put(headers: dict, provider: str, parameters: dict):
    with TestClient(app) as client:
        return client.put(f"{URL}/{provider}", headers=headers, json={"parameters": parameters})


def _get_as(headers: dict) -> dict:
    with TestClient(app) as client:
        response = client.get(URL, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _setting_rows() -> list[str]:
    async def read(session):
        return [row.providerKey.value.lower() for row in await session.scalars(select(LLMProviderSetting))]

    return _run(read)


def _audit_events(admin_headers: dict) -> list[AdminAuditEvent]:
    async def read(session):
        rows = await session.scalars(
            select(AdminAuditEvent)
            .where(AdminAuditEvent.actorUserId == admin_headers["X-User-Id"])
            .order_by(AdminAuditEvent.createdAt, AdminAuditEvent.field)
        )
        return list(rows)

    return _run(read)


def test_put_requires_administrator():
    response = _put(
        {**HEADERS, "X-User-Role": "EXTERNAL", "X-User-Id": "u"}, "ollama", {"model": "x"}
    )

    assert response.status_code == 403
    assert _setting_rows() == []


def test_put_stores_non_secret_values_and_get_reads_them_back(admin):
    response = _put(
        admin,
        "ollama",
        {"baseUrl": "http://gpu-box:11434/v1", "model": "qwen3:8b"},
    )

    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["key"] == "ollama"
    assert saved["configuration"] == "configured"
    assert saved["settingId"] is not None
    assert saved["updatedAt"] is not None
    for name, value in (("baseUrl", "http://gpu-box:11434/v1"), ("model", "qwen3:8b")):
        parameter = _parameter(saved, name)
        assert (parameter["source"], parameter["value"]) == ("stored", value)

    listed = _provider(_get_as(admin), "ollama")
    assert listed == saved


def test_no_setting_exists_for_a_provider_that_was_never_saved(admin):
    _put(admin, "ollama", {"model": "qwen3:8b"})

    body = _get_as(admin)

    assert _setting_rows() == ["ollama"]
    for key in ("anthropic", "openai", "openrouter", "huggingface"):
        provider = _provider(body, key)
        assert provider["settingId"] is None
        assert provider["updatedAt"] is None
    assert body["activeProvider"] is None
    assert _provider(body, "ollama")["active"] is False


def test_each_provider_holds_its_own_stored_values(admin):
    _put(admin, "ollama", {"model": "qwen3:8b"})
    _put(admin, "openai", {"model": "gpt-4.1"})

    body = _get_as(admin)

    assert _parameter(_provider(body, "ollama"), "model")["value"] == "qwen3:8b"
    assert _parameter(_provider(body, "openai"), "model")["value"] == "gpt-4.1"
    assert _parameter(_provider(body, "anthropic"), "model")["source"] == "default"


def test_a_stored_value_beats_the_environment(admin, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://from-env:11434/v1")

    saved = _put(admin, "ollama", {"baseUrl": "http://stored:11434/v1"}).json()

    base_url = _parameter(saved, "baseUrl")
    assert (base_url["source"], base_url["value"]) == ("stored", "http://stored:11434/v1")


def test_blank_non_secret_removes_the_stored_value_and_falls_back(admin, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://from-env:11434/v1")
    _put(admin, "ollama", {"baseUrl": "http://stored:11434/v1", "model": "qwen3:8b"})

    saved = _put(admin, "ollama", {"baseUrl": "   ", "model": ""}).json()

    base_url = _parameter(saved, "baseUrl")
    assert (base_url["source"], base_url["value"]) == ("environment", "http://from-env:11434/v1")
    model = _parameter(saved, "model")
    assert (model["source"], model["value"]) == ("default", "qwen3.5:latest")
    assert saved["configuration"] == "inherited"


def test_null_clears_the_stored_value(admin):
    _put(admin, "ollama", {"model": "qwen3:8b"})

    saved = _put(admin, "ollama", {"model": None}).json()

    assert _parameter(saved, "model")["source"] == "default"


def test_an_omitted_parameter_is_left_unchanged(admin):
    _put(admin, "ollama", {"baseUrl": "http://gpu-box:11434/v1", "model": "qwen3:8b"})

    saved = _put(admin, "ollama", {"model": "llama3.2"}).json()

    assert _parameter(saved, "baseUrl")["value"] == "http://gpu-box:11434/v1"
    assert _parameter(saved, "model")["value"] == "llama3.2"


def test_surrounding_whitespace_is_not_stored(admin):
    saved = _put(admin, "ollama", {"model": "  qwen3:8b \n"}).json()

    assert _parameter(saved, "model")["value"] == "qwen3:8b"


def test_an_incomplete_configuration_can_be_saved(admin):
    response = _put(admin, "openai", {"model": "gpt-4.1"})

    assert response.status_code == 200, response.text
    assert response.json()["configuration"] == "incomplete"


def test_configured_needs_a_stored_value_and_every_required_parameter_resolved(admin, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-from-the-environment")

    saved = _put(admin, "openai", {"model": "gpt-4.1"}).json()

    assert saved["configuration"] == "configured"
    assert _parameter(saved, "apiKey")["source"] == "environment"


def test_saving_nothing_creates_no_setting(admin):
    response = _put(admin, "ollama", {"model": "", "baseUrl": None})

    assert response.status_code == 200
    assert response.json()["settingId"] is None
    assert _setting_rows() == []
    assert _audit_events(admin) == []


def test_unknown_provider_is_a_404(admin):
    response = _put(admin, "gemini", {"model": "x"})

    assert response.status_code == 404
    assert _setting_rows() == []


def test_unknown_parameter_is_a_422_and_stores_nothing(admin):
    # `apiKey` is not an ollama parameter.
    for parameters in ({"temperature": "0.2"}, {"model": "qwen3:8b", "apiKey": "x"}):
        response = _put(admin, "ollama", parameters)

        assert response.status_code == 422, response.text
    assert _setting_rows() == []
    assert _audit_events(admin) == []


@pytest.mark.parametrize(
    "value",
    ["localhost:11434", "gpu-box", "ftp://gpu-box/v1", "http://", "/v1", "http://exa mple.com"],
)
def test_base_url_that_is_not_an_absolute_http_url_is_a_422(admin, value):
    response = _put(admin, "ollama", {"baseUrl": value})

    assert response.status_code == 422, response.text
    assert _setting_rows() == []


@pytest.mark.parametrize("value", ["http://gpu-box:11434/v1", "https://ollama.example.com"])
def test_absolute_http_and_https_base_urls_are_accepted(admin, value):
    assert _put(admin, "ollama", {"baseUrl": value}).status_code == 200


def test_secret_values_are_refused_until_they_can_be_encrypted(admin):
    response = _put(admin, "openai", {"apiKey": "sk-should-never-be-stored-1234", "model": "gpt-4.1"})

    assert response.status_code == 422
    assert "sk-should-never-be-stored-1234" not in response.text
    assert _setting_rows() == []


def test_blank_secret_means_unchanged(admin):
    response = _put(admin, "openai", {"apiKey": "", "model": "gpt-4.1"})

    assert response.status_code == 200, response.text
    assert _parameter(response.json(), "apiKey")["source"] == "unresolved"


def test_a_failed_save_stores_none_of_its_other_parameters(admin):
    response = _put(admin, "ollama", {"model": "qwen3:8b", "baseUrl": "not-a-url"})

    assert response.status_code == 422
    assert _setting_rows() == []


def test_audit_event_per_changed_parameter_with_real_values(admin):
    _put(admin, "ollama", {"baseUrl": "http://gpu-box:11434/v1", "model": "qwen3:8b"})
    _put(admin, "ollama", {"model": "llama3.2", "baseUrl": None})

    events = _audit_events(admin)

    assert sorted((e.field, e.oldValue, e.newValue) for e in events) == sorted(
        [
            ("llmProviderSetting:ollama:baseUrl", "null", "http://gpu-box:11434/v1"),
            ("llmProviderSetting:ollama:model", "null", "qwen3:8b"),
            ("llmProviderSetting:ollama:model", "qwen3:8b", "llama3.2"),
            ("llmProviderSetting:ollama:baseUrl", "http://gpu-box:11434/v1", "null"),
        ]
    )
    assert all(event.targetUserId is None for event in events)


def test_a_save_that_changes_nothing_writes_no_audit_event(admin):
    _put(admin, "ollama", {"model": "qwen3:8b"})
    before = len(_audit_events(admin))

    # Same value, a clear of something never stored, and an omitted parameter.
    _put(admin, "ollama", {"model": "qwen3:8b", "baseUrl": ""})

    assert len(_audit_events(admin)) == before == 1
