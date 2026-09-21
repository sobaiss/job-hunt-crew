"""The Active LLM provider resolver (issue #177, docs/adr/0024): given a
session, returns the `LLMProvider` a pipeline step runs on. Settings are seeded
in the real docker-compose Postgres and the SDK constructors are patched, like
test_llm_provider.py -- asserting what a client is built with, never how the
resolver got there.
"""

import logging
from unittest.mock import MagicMock, patch

import pytest
from cryptography.fernet import Fernet
from llm_settings import LLM_ENV_VARS, seed_setting, wipe_settings
from py_db.models import Llmproviderkey, LLMProviderSetting, LLMProviderSettingValue
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select, update

from analysis.llm_provider import (
    AnthropicProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
)
from analysis.llm_provider_resolver import (
    LLMProviderResolutionError,
    resolve_llm_provider,
)


@pytest.fixture(autouse=True)
def _clean_llm_env(monkeypatch):
    for name in LLM_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def encryption_key(monkeypatch) -> str:
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", key)
    return key


@pytest.fixture
async def session_factory():
    engine = make_engine()
    factory = make_session_factory(engine)
    await wipe_settings(factory)
    yield factory
    await wipe_settings(factory)
    await engine.dispose()


@pytest.fixture
def openai_ctor():
    with patch("analysis.llm_provider.openai.OpenAI", return_value=MagicMock()) as ctor:
        yield ctor


@pytest.fixture
def anthropic_ctor():
    with patch(
        "analysis.llm_provider.anthropic.Anthropic", return_value=MagicMock()
    ) as ctor:
        yield ctor


async def test_no_active_setting_behaves_as_the_environment_only_factory(
    session_factory, openai_ctor, monkeypatch
):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_MODEL", "env-model")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://env-ollama:11434/v1")

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert isinstance(provider, OllamaProvider)
    # LLM_MODEL is honoured in the environment-driven mode.
    assert provider.model == "env-model"
    assert openai_ctor.call_args.kwargs["base_url"] == "http://env-ollama:11434/v1"


async def test_a_saved_but_inactive_setting_leaves_the_environment_in_charge(
    session_factory, openai_ctor, monkeypatch
):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    await seed_setting(
        session_factory,
        Llmproviderkey.OLLAMA,
        active=False,
        values={"model": "stored-model"},
    )

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert provider.model != "stored-model"


async def test_an_active_ollama_setting_builds_the_client_from_its_stored_values(
    session_factory, openai_ctor, monkeypatch
):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")  # the setting overrides this
    await seed_setting(
        session_factory,
        Llmproviderkey.OLLAMA,
        values={"model": "stored-model", "baseUrl": "http://stored-host:11434/v1"},
    )

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert isinstance(provider, OllamaProvider)
    assert provider.model == "stored-model"
    assert openai_ctor.call_args.kwargs["base_url"] == "http://stored-host:11434/v1"


async def test_each_parameter_falls_back_independently(
    session_factory, openai_ctor, monkeypatch
):
    await seed_setting(
        session_factory, Llmproviderkey.OLLAMA, values={"model": "stored-model"}
    )

    # No stored base URL: the environment's...
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://env-ollama:11434/v1")
    async with session_factory() as session:
        provider = await resolve_llm_provider(session)
    assert provider.model == "stored-model"
    assert openai_ctor.call_args.kwargs["base_url"] == "http://env-ollama:11434/v1"

    # ...and with none of those either, the provider's own default.
    monkeypatch.delenv("OLLAMA_BASE_URL")
    async with session_factory() as session:
        await resolve_llm_provider(session)
    assert openai_ctor.call_args.kwargs["base_url"] == "http://localhost:11434/v1"


@pytest.mark.parametrize("stored", [{}, {"model": ""}], ids=["absent", "empty"])
async def test_a_missing_stored_model_uses_the_providers_default_not_llm_model(
    session_factory, openai_ctor, monkeypatch, stored
):
    monkeypatch.setenv("LLM_MODEL", "env-model")
    await seed_setting(session_factory, Llmproviderkey.OLLAMA, values=stored)

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert provider.model == "qwen3.5:latest"


async def test_an_active_hosted_provider_without_a_key_fails_naming_provider_and_parameter(
    session_factory, openai_ctor, anthropic_ctor, monkeypatch
):
    # The environment would happily run ollama; the resolver must not fall back.
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    await seed_setting(session_factory, Llmproviderkey.OPENAI)

    async with session_factory() as session:
        with pytest.raises(LLMProviderResolutionError) as excinfo:
            await resolve_llm_provider(session)

    assert "OpenAI" in str(excinfo.value)
    assert "apiKey" in str(excinfo.value)
    openai_ctor.assert_not_called()
    anthropic_ctor.assert_not_called()


async def test_anthropic_with_an_environment_key_leaves_it_to_the_sdk_to_discover(
    session_factory, anthropic_ctor, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env")
    await seed_setting(
        session_factory, Llmproviderkey.ANTHROPIC, values={"model": "stored-claude"}
    )

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert isinstance(provider, AnthropicProvider)
    assert provider.model == "stored-claude"
    anthropic_ctor.assert_called_once_with()


async def test_openai_with_an_environment_key_leaves_it_to_the_sdk_to_discover(
    session_factory, openai_ctor, monkeypatch
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    await seed_setting(session_factory, Llmproviderkey.OPENAI)

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert isinstance(provider, OpenAIProvider)
    openai_ctor.assert_called_once_with()


async def test_openrouter_is_handed_its_environment_key_explicitly(
    session_factory, openai_ctor, monkeypatch
):
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-env")
    await seed_setting(
        session_factory, Llmproviderkey.OPENROUTER, values={"model": "vendor/stored"}
    )

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert isinstance(provider, OpenRouterProvider)
    assert provider.model == "vendor/stored"
    assert openai_ctor.call_args.kwargs["api_key"] == "or-env"
    assert openai_ctor.call_args.kwargs["base_url"] == "https://openrouter.ai/api/v1"


async def test_nothing_is_cached_between_resolutions_on_the_same_session(
    session_factory, openai_ctor
):
    setting_id = await seed_setting(
        session_factory, Llmproviderkey.OLLAMA, values={"model": "first-model"}
    )

    async with session_factory() as session:
        assert (await resolve_llm_provider(session)).model == "first-model"

        # An Administrator changes the model between two steps (another session).
        async with session_factory() as admin_session:
            await admin_session.execute(
                update(LLMProviderSettingValue)
                .where(LLMProviderSettingValue.settingId == setting_id)
                .values(value="second-model")
            )
            await admin_session.commit()

        assert (await resolve_llm_provider(session)).model == "second-model"

        # ...and deactivating hands control back to the environment.
        async with session_factory() as admin_session:
            await admin_session.execute(
                update(LLMProviderSetting).values(isActive=False)
            )
            await admin_session.commit()

        assert (await resolve_llm_provider(session)).model != "second-model"


# --- Stored secrets (#178) --------------------------------------------------


def _undecryptable_logs(caplog) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if getattr(record, "fields", {}).get("event")
        == "llm_provider_secret_undecryptable"
    ]


async def test_a_stored_openai_key_reaches_the_sdk_client(
    session_factory, openai_ctor, encryption_key, monkeypatch
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")  # the stored key beats it
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENAI,
        secrets={"apiKey": "sk-stored-0123456789"},
    )

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert isinstance(provider, OpenAIProvider)
    assert openai_ctor.call_args.kwargs["api_key"] == "sk-stored-0123456789"


async def test_a_stored_anthropic_key_reaches_the_sdk_client(
    session_factory, anthropic_ctor, encryption_key
):
    await seed_setting(
        session_factory,
        Llmproviderkey.ANTHROPIC,
        secrets={"apiKey": "sk-ant-stored-0123456789"},
    )

    async with session_factory() as session:
        await resolve_llm_provider(session)

    assert anthropic_ctor.call_args.kwargs["api_key"] == "sk-ant-stored-0123456789"


async def test_a_stored_openrouter_key_beats_the_environment(
    session_factory, openai_ctor, encryption_key, monkeypatch
):
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-env")
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENROUTER,
        secrets={"apiKey": "or-stored-0123456789"},
    )

    async with session_factory() as session:
        await resolve_llm_provider(session)

    assert openai_ctor.call_args.kwargs["api_key"] == "or-stored-0123456789"


async def test_the_stored_key_is_ciphertext_in_the_database(
    session_factory, encryption_key
):
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENAI,
        secrets={"apiKey": "sk-stored-0123456789"},
    )

    async with session_factory() as session:
        row = await session.scalar(select(LLMProviderSettingValue))

    assert row is not None
    assert "sk-stored-0123456789" not in row.value
    assert row.lastFour == "6789"


async def test_a_secret_encrypted_under_another_key_falls_back_to_the_environment(
    session_factory, openai_ctor, encryption_key, monkeypatch, caplog
):
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENAI,
        secrets={"apiKey": "sk-stored-0123456789"},
    )
    # The key is rotated: what is stored can no longer be read.
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")

    with caplog.at_level(logging.ERROR):
        async with session_factory() as session:
            provider = await resolve_llm_provider(session)

    assert isinstance(provider, OpenAIProvider)
    # The environment key is left to SDK discovery: nothing is passed.
    openai_ctor.assert_called_once_with()
    (record,) = _undecryptable_logs(caplog)
    assert record.levelno == logging.ERROR
    assert record.fields["provider"] == "openai"
    assert record.fields["parameter"] == "apiKey"


async def test_a_secret_that_cannot_be_decrypted_and_has_no_environment_key_fails_the_step(
    session_factory, openai_ctor, encryption_key, monkeypatch, caplog
):
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENAI,
        secrets={"apiKey": "sk-stored-0123456789"},
    )
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", Fernet.generate_key().decode())

    with caplog.at_level(logging.ERROR):
        async with session_factory() as session:
            with pytest.raises(LLMProviderResolutionError) as excinfo:
                await resolve_llm_provider(session)

    assert "OpenAI" in str(excinfo.value)
    assert "apiKey" in str(excinfo.value)
    openai_ctor.assert_not_called()
    assert len(_undecryptable_logs(caplog)) == 1


async def test_a_stored_secret_with_no_encryption_key_is_treated_as_absent(
    session_factory, openai_ctor, encryption_key, monkeypatch, caplog
):
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENAI,
        secrets={"apiKey": "sk-stored-0123456789"},
    )
    monkeypatch.delenv("SETTINGS_ENCRYPTION_KEY")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")

    with caplog.at_level(logging.ERROR):
        async with session_factory() as session:
            await resolve_llm_provider(session)

    openai_ctor.assert_called_once_with()
    assert len(_undecryptable_logs(caplog)) == 1


async def test_no_log_line_contains_the_secret_or_its_ciphertext(
    session_factory, openai_ctor, encryption_key, monkeypatch, caplog
):
    await seed_setting(
        session_factory,
        Llmproviderkey.OPENAI,
        secrets={"apiKey": "sk-stored-0123456789"},
    )
    async with session_factory() as session:
        ciphertext = (await session.scalar(select(LLMProviderSettingValue))).value
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")

    with caplog.at_level(logging.DEBUG):
        async with session_factory() as session:
            await resolve_llm_provider(session)

    logged = " ".join(f"{r.getMessage()} {getattr(r, 'fields', '')}" for r in caplog.records)
    assert "sk-stored-0123456789" not in logged
    assert ciphertext not in logged


async def test_a_process_that_never_touches_a_secret_needs_no_encryption_key(
    session_factory, openai_ctor, monkeypatch
):
    monkeypatch.delenv("SETTINGS_ENCRYPTION_KEY", raising=False)
    await seed_setting(
        session_factory, Llmproviderkey.OLLAMA, values={"model": "stored-model"}
    )

    async with session_factory() as session:
        provider = await resolve_llm_provider(session)

    assert provider.model == "stored-model"
