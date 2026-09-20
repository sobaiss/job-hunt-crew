"""Admin LLM providers (issue #174, part of the #172 epic, docs/adr/0024).

Read-only for now: nothing is stored yet, so each provider's state is derived
from the catalogue plus the API's own environment. The API is given the same
LLM-related environment as the workers in docker-compose so this matches what
they actually run on. A secret supplied by the environment is reported only as
set -- its value never leaves this module.
"""

import os
from datetime import datetime

from fastapi import APIRouter, Depends
from py_db.llm_providers import (
    LLM_PROVIDERS,
    ProviderSpec,
    configuration_status,
    environment_provider_key,
    resolve_provider_parameters,
)
from pydantic import BaseModel

from .admin import require_admin

router = APIRouter(prefix="/v1/admin/llm-provider-settings")


class ProviderParameterItem(BaseModel):
    name: str
    secret: bool
    required: bool
    source: str
    # The effective value for a non-secret; always null for a secret.
    value: str | None
    # Whether any source resolves the value -- the only thing a secret reports.
    isSet: bool


class EnvironmentProvider(BaseModel):
    # Exactly one is non-null: the provider LLM_PROVIDER resolves to, or the
    # unsupported value it holds.
    key: str | None
    unsupportedValue: str | None


class LLMProviderItem(BaseModel):
    key: str
    displayName: str
    maturity: str
    active: bool
    configuration: str
    updatedAt: datetime | None
    settingId: str | None
    parameters: list[ProviderParameterItem]


class LLMProviderSettingsResponse(BaseModel):
    activeProvider: str | None
    environmentProvider: EnvironmentProvider
    providers: list[LLMProviderItem]


def _provider_item(spec: ProviderSpec, env: dict[str, str]) -> LLMProviderItem:
    resolved = resolve_provider_parameters(spec, {}, env)
    return LLMProviderItem(
        key=spec.key,
        displayName=spec.display_name,
        maturity=spec.maturity.value,
        active=False,
        configuration=configuration_status(spec, resolved).value,
        updatedAt=None,
        settingId=None,
        parameters=[
            ProviderParameterItem(
                name=parameter.name,
                secret=parameter.secret,
                required=parameter.required,
                source=resolved[parameter.name].source.value,
                value=None if parameter.secret else resolved[parameter.name].value,
                isSet=resolved[parameter.name].value is not None,
            )
            for parameter in spec.parameters
        ],
    )


@router.get("", response_model=LLMProviderSettingsResponse)
async def list_llm_provider_settings(
    _admin_id: str = Depends(require_admin),
) -> LLMProviderSettingsResponse:
    env = dict(os.environ)
    environment_key = environment_provider_key(env)
    return LLMProviderSettingsResponse(
        activeProvider=None,
        environmentProvider=EnvironmentProvider(
            key=environment_key,
            unsupportedValue=None if environment_key else env.get("LLM_PROVIDER"),
        ),
        providers=[_provider_item(spec, env) for spec in LLM_PROVIDERS],
    )
