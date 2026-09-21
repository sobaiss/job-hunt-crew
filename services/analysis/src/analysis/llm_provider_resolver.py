"""Resolves the `LLMProvider` a pipeline step runs on (issue #177,
docs/adr/0024).

With no Active LLM provider stored in Postgres this is exactly the
environment-only factory (`get_llm_provider`), `LLM_MODEL` included. With one,
the provider is built from its Effective provider parameters — stored value,
else environment variable, else hardcoded default, independently per
parameter — computed by the same `resolve_provider_parameters` the Admin
screen uses, so what is displayed cannot drift from what runs. A required
parameter that resolves nowhere fails the step; it never falls back to a
different provider.

A stored secret is decrypted with `SETTINGS_ENCRYPTION_KEY` (issue #178); one
that cannot be decrypted is treated as absent, with a loud log line.

Reads through the caller's own session (the callers already run inside an
event loop) and caches nothing: a change made between two pipeline steps takes
effect at the next step to start.
"""

import os
from collections.abc import Callable

from py_db.llm_providers import (
    EffectiveParameter,
    ParameterSource,
    ProviderSpec,
    get_provider_spec,
    resolve_provider_parameters,
)
from py_db.models import LLMProviderSetting
from py_db.settings_encryption import decrypt_secret
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .llm_provider import (
    AnthropicProvider,
    HuggingFaceProvider,
    LLMProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
    get_llm_provider,
)


class LLMProviderResolutionError(Exception):
    """The Active LLM provider cannot run: a required Provider parameter
    resolves nowhere. Names the provider and the parameter(s)."""


def _stored_values(spec: ProviderSpec, setting: LLMProviderSetting) -> dict[str, str]:
    """The stored values of `setting` that the catalogue still declares, secrets
    decrypted. A row for a parameter no longer in the catalogue is ignored, and
    so is a secret that cannot be decrypted (missing or rotated key, corrupt
    payload): it counts as absent, so the parameter falls back to the
    environment or is unresolved. `decrypt_secret` logs why."""
    parameters = {parameter.name: parameter for parameter in spec.parameters}
    values: dict[str, str] = {}
    for row in setting.LLMProviderSettingValue:
        parameter = parameters.get(row.parameterName)
        if parameter is None:
            continue
        if not parameter.secret:
            values[row.parameterName] = row.value
            continue
        secret = decrypt_secret(
            row.value, provider=spec.key, parameter=parameter.name
        )
        if secret is not None:
            values[row.parameterName] = secret
    return values


def _build_provider(
    spec: ProviderSpec, resolved: dict[str, EffectiveParameter]
) -> LLMProvider:
    # `model` always resolves (it has a default), so it is passed explicitly and
    # beats LLM_MODEL, which governs only the environment-driven factory.
    model = resolved["model"].value
    api_key = resolved["apiKey"] if "apiKey" in resolved else None
    if spec.key in ("anthropic", "openai"):
        # An environment key is left for the SDK to discover: passing it back
        # explicitly makes the Anthropic SDK warn about shadowing.
        stored = api_key is not None and api_key.source is ParameterSource.STORED
        provider_class = (
            AnthropicProvider if spec.key == "anthropic" else OpenAIProvider
        )
        return provider_class(
            model=model, api_key=api_key.value if stored else None
        )
    if spec.key in ("openrouter", "huggingface"):
        assert api_key is not None
        provider_class = (
            OpenRouterProvider if spec.key == "openrouter" else HuggingFaceProvider
        )
        return provider_class(model=model, api_key=api_key.value)
    if spec.key == "ollama":
        return OllamaProvider(model=model, base_url=resolved["baseUrl"].value)
    raise LookupError(f"No LLM provider client for catalogue provider {spec.key!r}")


async def resolve_llm_provider(
    session: AsyncSession,
    *,
    environment_factory: Callable[[], LLMProvider] = get_llm_provider,
) -> LLMProvider:
    """`environment_factory` builds the provider when nothing is active; a
    caller can pass its own reference to `get_llm_provider` so that name stays
    patchable in that caller's module."""
    # populate_existing: the session may already hold this row from an earlier
    # step; a stale copy would defeat "takes effect at the next step".
    setting = await session.scalar(
        select(LLMProviderSetting)
        .where(LLMProviderSetting.isActive.is_(True))
        .options(selectinload(LLMProviderSetting.LLMProviderSettingValue))
        .execution_options(populate_existing=True)
    )
    if setting is None:
        return environment_factory()

    spec = get_provider_spec(setting.providerKey.value.lower())
    resolved = resolve_provider_parameters(
        spec, _stored_values(spec, setting), dict(os.environ)
    )
    missing = [
        parameter.name
        for parameter in spec.parameters
        if parameter.required
        and resolved[parameter.name].source is ParameterSource.UNRESOLVED
    ]
    if missing:
        raise LLMProviderResolutionError(
            f"Active LLM provider {spec.display_name} cannot run: required "
            f"parameter(s) {', '.join(missing)} resolve nowhere"
        )
    return _build_provider(spec, resolved)
