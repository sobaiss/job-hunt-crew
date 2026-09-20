"""LLM provider abstraction (PRD Section 4: "LLM provider" row).

Selects between Anthropic Claude, OpenAI, OpenRouter, HuggingFace, and a local
Ollama runtime behind a single interface via the LLM_PROVIDER env var
(anthropic|openai|openrouter|huggingface|ollama), with the model id also
configurable via env var, so CrewAI agents built on top of this never import
an SDK directly or branch on provider.

`anthropic`/`openai` are the production-supported options. `openrouter`/
`huggingface` are also hosted, paid backends (API key required) — routed
through their OpenAI-compatible endpoints, reusing the `openai` SDK exactly
like `ollama` does below — but are opt-in for trying alternate models and not
yet vetted for production traffic.

`ollama` is a dev-local convenience only — no API key, no per-token cost — and
is *not* a supported production backend; production stays on anthropic|openai.
"""

import os
from abc import ABC, abstractmethod

import anthropic
import openai

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"
DEFAULT_OPENAI_MODEL = "gpt-4o"
DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4-5"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_HUGGINGFACE_MODEL = "meta-llama/Llama-3.3-70B-Instruct"
DEFAULT_HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1"
DEFAULT_OLLAMA_MODEL = "qwen3.5:latest"
DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1"

# Response cap used when a caller does not ask for a specific one.
DEFAULT_MAX_TOKENS = 4096

# Escalating temperature schedule for a bounded-retry caller's attempts
# 2/3 (comparison/recommendation/extraction agents' `range(1, MAX_ATTEMPTS +
# 1)` loops). Only OllamaProvider acts on this — see its `generate` — because
# only it hardcodes `temperature=0`, which makes a retry with the identical
# prompt deterministic and therefore pointless: attempt 1 stays at 0 (kept
# reproducible for the common case), later attempts raise it so a retry can
# reach a different completion instead of repeating the same broken one
# verbatim.
RETRY_TEMPERATURES = (0.0, 0.3, 0.6)


def retry_temperature(attempt: int) -> float:
    """`attempt` is 1-indexed, matching every caller's retry loop."""
    return RETRY_TEMPERATURES[min(attempt - 1, len(RETRY_TEMPERATURES) - 1)]


class LLMProvider(ABC):
    """Single interface every supported LLM backend implements."""

    @abstractmethod
    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        """Run one prompt through the configured model and return the text
        response. `max_tokens` overrides the provider's default response cap —
        used by the CV Conversion normalisation pass, whose faithful Markdown
        output of a multi-page CV runs longer than the shared default.
        `response_schema` (a Pydantic `.model_json_schema()`) and `temperature`
        are hints only Ollama acts on — see `OllamaProvider.generate` — so a
        bounded-retry caller can pass its result model's schema and an
        escalating `temperature` (`retry_temperature`) without every provider
        needing to support schema-constrained decoding or a per-attempt
        temperature."""


class AnthropicProvider(LLMProvider):
    def __init__(
        self, *, model: str | None = None, client: anthropic.Anthropic | None = None
    ) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_ANTHROPIC_MODEL
        self.client = client or anthropic.Anthropic()

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        del (
            response_schema,
            temperature,
        )  # unused: Anthropic hasn't shown Ollama's failure modes
        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens or DEFAULT_MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text


class OpenAIProvider(LLMProvider):
    def __init__(
        self, *, model: str | None = None, client: openai.OpenAI | None = None
    ) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_OPENAI_MODEL
        self.client = client or openai.OpenAI()

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        del (
            response_schema,
            temperature,
        )  # unused: OpenAI hasn't shown Ollama's failure modes
        optional = {"max_tokens": max_tokens} if max_tokens is not None else {}
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            **optional,
        )
        return response.choices[0].message.content


class OpenRouterProvider(LLMProvider):
    """Routes every call through OpenRouter's OpenAI-compatible API — hosted,
    paid, API key required, opt-in for trying alternate models (not yet
    vetted for production traffic; production stays on anthropic|openai).

    Transport reuses the already-vendored `openai` SDK against a fixed
    `base_url` — same trick as `OllamaProvider` — no new dependency. Unlike
    Ollama, `response_schema`/`temperature` are ignored (same as Anthropic/
    OpenAI above): OpenRouter proxies many different underlying models and
    not all of them support strict json_schema mode, so constrained decoding
    isn't applied here until a real model/failure shows it's needed.
    """

    def __init__(
        self, *, model: str | None = None, client: openai.OpenAI | None = None
    ) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_OPENROUTER_MODEL
        self.client = client or openai.OpenAI(
            base_url=DEFAULT_OPENROUTER_BASE_URL,
            api_key=os.environ.get("OPENROUTER_API_KEY"),
        )

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        del response_schema, temperature  # see class docstring
        optional = {"max_tokens": max_tokens} if max_tokens is not None else {}
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            **optional,
        )
        return response.choices[0].message.content


class HuggingFaceProvider(LLMProvider):
    """Routes every call through HuggingFace's unified OpenAI-compatible
    Inference Providers router — hosted, paid, API key required, opt-in for
    trying alternate models (not yet vetted for production traffic;
    production stays on anthropic|openai).

    Transport reuses the already-vendored `openai` SDK against a fixed
    `base_url` — same trick as `OllamaProvider`/`OpenRouterProvider` — no new
    dependency (the native `huggingface_hub` SDK is not used). Like
    OpenRouterProvider, `response_schema`/`temperature` are ignored: the
    router proxies many different underlying models/backends, and strict
    json_schema support isn't consistent across them.
    """

    def __init__(
        self, *, model: str | None = None, client: openai.OpenAI | None = None
    ) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_HUGGINGFACE_MODEL
        self.client = client or openai.OpenAI(
            base_url=DEFAULT_HUGGINGFACE_BASE_URL,
            api_key=os.environ.get("HF_TOKEN"),
        )

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        del response_schema, temperature  # see class docstring
        optional = {"max_tokens": max_tokens} if max_tokens is not None else {}
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            **optional,
        )
        return response.choices[0].message.content


class OllamaProvider(LLMProvider):
    """Routes every call to a local Ollama server through its OpenAI-compatible
    API — no API key, no per-token cost. Dev-local convenience only, *not* a
    supported production backend.

    Standalone (not an `OpenAIProvider` subclass) so its `temperature=0` /
    `base_url` / dummy-key contract stays decoupled from future `OpenAIProvider`
    edits. Transport reuses the already-vendored `openai` SDK — no new
    dependency — against `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`)
    with a hardcoded dummy key (the SDK rejects an empty one; Ollama ignores the
    value). No reachability preflight: an unreachable server surfaces as the
    caller's bounded retry loop exhausting into a terminal FAILED state, exactly
    like a hosted-provider outage.
    """

    def __init__(
        self, *, model: str | None = None, client: openai.OpenAI | None = None
    ) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_OLLAMA_MODEL
        # `or` (not get's default arg): docker-compose injects OLLAMA_BASE_URL as
        # an empty string via `${OLLAMA_BASE_URL:-}` when the host env is unset,
        # and `openai.OpenAI(base_url="")` fails every call with "Connection
        # error" rather than falling back to the real default.
        self.client = client or openai.OpenAI(
            base_url=os.environ.get("OLLAMA_BASE_URL") or DEFAULT_OLLAMA_BASE_URL,
            api_key="ollama",
        )

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        optional = {"max_tokens": max_tokens} if max_tokens is not None else {}
        # When a caller passes `response_schema` (its result Pydantic model's
        # `.model_json_schema()`), `json_schema` mode grammar-constrains
        # decoding to that schema, closing the failure mode where qwen3.5
        # (the dev default) emits a raw quote/newline inside a string value
        # (breaking `json.loads`) or valid-but-incomplete JSON missing a
        # required field. Callers with no JSON result shape (CV
        # conversion/tailoring, cover letters) get no `response_format` at
        # all: forcing `json_object` mode here previously fought their own
        # prompt's "respond with ONLY prose, no JSON" instruction, and under
        # that conflict qwen3.5 was observed producing hybrid CV+letter
        # output with undecoded `\uXXXX` escapes leaking through.
        if response_schema is not None:
            optional["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "response",
                    "schema": response_schema,
                    "strict": True,
                },
            }
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            # Even `json_schema` grammar-constrained decoding can still land
            # on a schema-violating completion for a specific prompt at
            # `temperature=0` (observed live: qwen3.5 deterministically
            # omitted a required enum field for one real comparison/
            # recommendation pair, regardless of schema shape/field order) —
            # and since that's deterministic, a caller's bounded retry with
            # the identical prompt would repeat the identical failure 3
            # times for nothing. Defaulting to 0 keeps the common case
            # reproducible; a caller whose retry loop passes a nonzero
            # `temperature` (`retry_temperature`, attempts 2/3) gets an
            # actual chance at a different, hopefully conforming completion.
            temperature=temperature if temperature is not None else 0,
            # Hybrid "thinking" models (e.g. qwen3.5, the dev default) stream
            # their chain-of-thought into a separate `reasoning` field before
            # `content`. On a large enough prompt that reasoning alone can
            # exceed `max_tokens`, cutting generation off before `content` is
            # ever started — the call still returns 200 OK but with
            # content == "", breaking every JSON-parsing caller (this is what
            # broke StyleProfile classification in style_profile.py).
            # `reasoning_effort="none"` is an Ollama extension, not a modeled
            # OpenAI SDK param, hence extra_body — it turns thinking off so
            # `content` always carries the full answer.
            extra_body={"reasoning_effort": "none"},
            **optional,
        )
        return response.choices[0].message.content


class UnknownLLMProviderError(ValueError):
    pass


def get_llm_provider() -> LLMProvider:
    """Factory selecting the configured provider per LLM_PROVIDER
    (anthropic|openai|openrouter|huggingface|ollama)."""
    provider = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if provider == "anthropic":
        return AnthropicProvider()
    if provider == "openai":
        return OpenAIProvider()
    if provider == "openrouter":
        return OpenRouterProvider()
    if provider == "huggingface":
        return HuggingFaceProvider()
    if provider == "ollama":
        return OllamaProvider()
    raise UnknownLLMProviderError(
        f"Unknown LLM_PROVIDER {provider!r}; expected "
        "anthropic | openai | openrouter | huggingface | ollama"
    )
