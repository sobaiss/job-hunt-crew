from unittest.mock import MagicMock, patch

import pytest

from analysis.llm_provider import (
    AnthropicProvider,
    OpenAIProvider,
    UnknownLLMProviderError,
    get_llm_provider,
)


def test_get_llm_provider_anthropic_calls_anthropic_sdk(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    fake_client = MagicMock()
    fake_response = MagicMock()
    fake_response.content = [MagicMock(text="anthropic reply")]
    fake_client.messages.create.return_value = fake_response

    with (
        patch("analysis.llm_provider.anthropic.Anthropic", return_value=fake_client) as anthropic_ctor,
        patch("analysis.llm_provider.openai.OpenAI") as openai_ctor,
    ):
        provider = get_llm_provider()
        assert isinstance(provider, AnthropicProvider)
        result = provider.generate(system="sys", prompt="hello")

    anthropic_ctor.assert_called_once()
    fake_client.messages.create.assert_called_once_with(
        model=provider.model,
        max_tokens=4096,
        system="sys",
        messages=[{"role": "user", "content": "hello"}],
    )
    assert result == "anthropic reply"
    openai_ctor.assert_not_called()


def test_get_llm_provider_openai_calls_openai_sdk(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    fake_client = MagicMock()
    fake_response = MagicMock()
    fake_response.choices = [MagicMock(message=MagicMock(content="openai reply"))]
    fake_client.chat.completions.create.return_value = fake_response

    with (
        patch("analysis.llm_provider.openai.OpenAI", return_value=fake_client) as openai_ctor,
        patch("analysis.llm_provider.anthropic.Anthropic") as anthropic_ctor,
    ):
        provider = get_llm_provider()
        assert isinstance(provider, OpenAIProvider)
        result = provider.generate(system="sys", prompt="hello")

    openai_ctor.assert_called_once()
    fake_client.chat.completions.create.assert_called_once_with(
        model=provider.model,
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
    )
    assert result == "openai reply"
    anthropic_ctor.assert_not_called()


def test_get_llm_provider_defaults_to_anthropic(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    with patch("analysis.llm_provider.anthropic.Anthropic") as anthropic_ctor:
        provider = get_llm_provider()
    assert isinstance(provider, AnthropicProvider)
    anthropic_ctor.assert_called_once()


def test_get_llm_provider_unknown_raises(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "bogus")
    with pytest.raises(UnknownLLMProviderError):
        get_llm_provider()


def test_llm_model_env_var_overrides_default(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "claude-custom")
    with patch("analysis.llm_provider.anthropic.Anthropic"):
        provider = AnthropicProvider()
    assert provider.model == "claude-custom"
