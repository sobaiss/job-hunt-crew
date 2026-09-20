from unittest.mock import MagicMock, patch

import pytest
from analysis.llm_provider import (
    AnthropicProvider,
    HuggingFaceProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
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
        patch(
            "analysis.llm_provider.anthropic.Anthropic", return_value=fake_client
        ) as anthropic_ctor,
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
        patch(
            "analysis.llm_provider.openai.OpenAI", return_value=fake_client
        ) as openai_ctor,
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


def test_get_llm_provider_openrouter_calls_openai_sdk(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    monkeypatch.delenv("LLM_MODEL", raising=False)
    fake_client = MagicMock()
    fake_response = MagicMock()
    fake_response.choices = [MagicMock(message=MagicMock(content="openrouter reply"))]
    fake_client.chat.completions.create.return_value = fake_response

    with patch(
        "analysis.llm_provider.openai.OpenAI", return_value=fake_client
    ) as openai_ctor:
        provider = get_llm_provider()
        assert isinstance(provider, OpenRouterProvider)
        result = provider.generate(system="sys", prompt="hello")

    openai_ctor.assert_called_once_with(
        base_url="https://openrouter.ai/api/v1", api_key="or-key"
    )
    fake_client.chat.completions.create.assert_called_once_with(
        model="anthropic/claude-sonnet-4-5",
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
    )
    assert result == "openrouter reply"


def test_openrouter_llm_model_env_var_overrides_default(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "openai/gpt-4o-mini")
    with patch("analysis.llm_provider.openai.OpenAI"):
        provider = OpenRouterProvider()
    assert provider.model == "openai/gpt-4o-mini"


def test_get_llm_provider_huggingface_calls_openai_sdk(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "huggingface")
    monkeypatch.setenv("HF_TOKEN", "hf-key")
    monkeypatch.delenv("LLM_MODEL", raising=False)
    fake_client = MagicMock()
    fake_response = MagicMock()
    fake_response.choices = [MagicMock(message=MagicMock(content="hf reply"))]
    fake_client.chat.completions.create.return_value = fake_response

    with patch(
        "analysis.llm_provider.openai.OpenAI", return_value=fake_client
    ) as openai_ctor:
        provider = get_llm_provider()
        assert isinstance(provider, HuggingFaceProvider)
        result = provider.generate(system="sys", prompt="hello")

    openai_ctor.assert_called_once_with(
        base_url="https://router.huggingface.co/v1", api_key="hf-key"
    )
    fake_client.chat.completions.create.assert_called_once_with(
        model="meta-llama/Llama-3.3-70B-Instruct",
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
    )
    assert result == "hf reply"


def test_huggingface_llm_model_env_var_overrides_default(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen2.5-72B-Instruct")
    with patch("analysis.llm_provider.openai.OpenAI"):
        provider = HuggingFaceProvider()
    assert provider.model == "Qwen/Qwen2.5-72B-Instruct"


def test_get_llm_provider_ollama_returns_ollama_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    with patch("analysis.llm_provider.openai.OpenAI") as openai_ctor:
        provider = get_llm_provider()
    assert isinstance(provider, OllamaProvider)
    openai_ctor.assert_called_once_with(
        base_url="http://localhost:11434/v1", api_key="ollama"
    )
    assert provider.model == "qwen3.5:latest"


def test_ollama_llm_model_env_var_overrides_default(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "llama3.1:8b")
    with patch("analysis.llm_provider.openai.OpenAI"):
        provider = OllamaProvider()
    assert provider.model == "llama3.1:8b"


def test_ollama_base_url_env_var_overrides_default(monkeypatch):
    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1")
    with patch("analysis.llm_provider.openai.OpenAI") as openai_ctor:
        OllamaProvider()
    openai_ctor.assert_called_once_with(
        base_url="http://host.docker.internal:11434/v1", api_key="ollama"
    )


def test_ollama_empty_base_url_env_var_falls_back_to_default(monkeypatch):
    # docker-compose's `${OLLAMA_BASE_URL:-}` sets the var to "" when the host
    # env is unset; that must not reach openai.OpenAI(base_url="").
    monkeypatch.delenv("LLM_MODEL", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "")
    with patch("analysis.llm_provider.openai.OpenAI") as openai_ctor:
        OllamaProvider()
    openai_ctor.assert_called_once_with(
        base_url="http://localhost:11434/v1", api_key="ollama"
    )


def test_ollama_generate_passes_temperature_zero_and_omits_max_tokens(monkeypatch):
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="ollama reply"))]
    )
    provider = OllamaProvider(model="qwen2.5:7b", client=fake_client)

    result = provider.generate(system="sys", prompt="hello")

    assert result == "ollama reply"
    fake_client.chat.completions.create.assert_called_once_with(
        model="qwen2.5:7b",
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
        temperature=0,
        extra_body={"reasoning_effort": "none"},
    )


def test_ollama_generate_forwards_max_tokens_when_given(monkeypatch):
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="ollama reply"))]
    )
    provider = OllamaProvider(model="qwen2.5:7b", client=fake_client)

    provider.generate(system="sys", prompt="hello", max_tokens=8192)

    fake_client.chat.completions.create.assert_called_once_with(
        model="qwen2.5:7b",
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
        temperature=0,
        extra_body={"reasoning_effort": "none"},
        max_tokens=8192,
    )


def test_ollama_generate_omits_response_format_without_schema(monkeypatch):
    # Regression test: forcing json_object mode for prose-only callers (cover
    # letters, CV tailoring) fought their own prompt's "respond with ONLY
    # prose, no JSON" instruction and produced hybrid CV+letter output with
    # undecoded `\uXXXX` escapes (analysis 8132ec06-6d99-4624-8d0e-60904dfa4a19).
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="prose reply"))]
    )
    provider = OllamaProvider(model="qwen2.5:7b", client=fake_client)

    provider.generate(system="sys", prompt="hello")

    _, kwargs = fake_client.chat.completions.create.call_args
    assert "response_format" not in kwargs


def test_ollama_generate_uses_json_schema_mode_when_schema_given(monkeypatch):
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="{}"))]
    )
    provider = OllamaProvider(model="qwen2.5:7b", client=fake_client)
    schema = {"type": "object", "properties": {}}

    provider.generate(system="sys", prompt="hello", response_schema=schema)

    fake_client.chat.completions.create.assert_called_once_with(
        model="qwen2.5:7b",
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
        temperature=0,
        extra_body={"reasoning_effort": "none"},
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "response",
                "schema": schema,
                "strict": True,
            },
        },
    )


def test_get_llm_provider_unknown_message_lists_ollama(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "bogus")
    with pytest.raises(UnknownLLMProviderError) as excinfo:
        get_llm_provider()
    assert "anthropic | openai | openrouter | huggingface | ollama" in str(
        excinfo.value
    )


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
