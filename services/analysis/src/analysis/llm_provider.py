"""LLM provider abstraction (PRD Section 4: "LLM provider" row).

Selects between Anthropic Claude and OpenAI behind a single interface via the
LLM_PROVIDER env var (anthropic|openai), with the model id also configurable
via env var, so CrewAI agents built on top of this never import an SDK
directly or branch on provider.
"""

import os
from abc import ABC, abstractmethod

import anthropic
import openai

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"
DEFAULT_OPENAI_MODEL = "gpt-4o"

# Response cap used when a caller does not ask for a specific one.
DEFAULT_MAX_TOKENS = 4096


class LLMProvider(ABC):
    """Single interface every supported LLM backend implements."""

    @abstractmethod
    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
        """Run one prompt through the configured model and return the text
        response. `max_tokens` overrides the provider's default response cap —
        used by the CV Conversion normalisation pass, whose faithful Markdown
        output of a multi-page CV runs longer than the shared default."""


class AnthropicProvider(LLMProvider):
    def __init__(self, *, model: str | None = None, client: anthropic.Anthropic | None = None) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_ANTHROPIC_MODEL
        self.client = client or anthropic.Anthropic()

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens or DEFAULT_MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text


class OpenAIProvider(LLMProvider):
    def __init__(self, *, model: str | None = None, client: openai.OpenAI | None = None) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_OPENAI_MODEL
        self.client = client or openai.OpenAI()

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
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


class UnknownLLMProviderError(ValueError):
    pass


def get_llm_provider() -> LLMProvider:
    """Factory selecting the configured provider per LLM_PROVIDER (anthropic|openai)."""
    provider = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if provider == "anthropic":
        return AnthropicProvider()
    if provider == "openai":
        return OpenAIProvider()
    raise UnknownLLMProviderError(
        f"Unknown LLM_PROVIDER {provider!r}; expected 'anthropic' or 'openai'"
    )
