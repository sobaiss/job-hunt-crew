"""Admin LLM providers (issues #174/#175, part of the #172 epic,
docs/adr/0024).

Each provider's state is derived from what an Administrator stored in
Postgres, the catalogue and the API's own environment. The API is given the
same LLM-related environment as the workers in docker-compose so this matches
what they actually run on. Only non-secret parameters can be stored so far; a
secret supplied by the environment is reported only as set -- its value never
leaves this module.
"""

import os
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from py_db.llm_providers import (
    LLM_PROVIDERS,
    ProviderSpec,
    configuration_status,
    environment_provider_key,
    get_provider_spec,
    resolve_provider_parameters,
)
from py_db.models import Llmproviderkey, LLMProviderSetting, LLMProviderSettingValue
from py_db.quotas import record_admin_audit_event
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .admin import require_admin
from .db import get_session

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


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _provider_key(spec: ProviderSpec) -> Llmproviderkey:
    return Llmproviderkey(spec.key.upper())


def _stored_values(spec: ProviderSpec, setting: LLMProviderSetting | None) -> dict[str, str]:
    """The non-secret stored values of `setting` that the catalogue still
    declares. A row for a parameter no longer in the catalogue is ignored, and
    so is a stored secret until the encrypted-keys ticket (#178) can read it."""
    if setting is None:
        return {}
    known = {parameter.name for parameter in spec.parameters if not parameter.secret}
    return {
        row.parameterName: row.value
        for row in setting.LLMProviderSettingValue
        if row.parameterName in known
    }


async def _load_settings(session: AsyncSession) -> dict[str, LLMProviderSetting]:
    rows = await session.scalars(
        select(LLMProviderSetting)
        .options(selectinload(LLMProviderSetting.LLMProviderSettingValue))
        .execution_options(populate_existing=True)
    )
    return {row.providerKey.value.lower(): row for row in rows}


def _provider_item(
    spec: ProviderSpec, env: dict[str, str], setting: LLMProviderSetting | None
) -> LLMProviderItem:
    resolved = resolve_provider_parameters(spec, _stored_values(spec, setting), env)
    return LLMProviderItem(
        key=spec.key,
        displayName=spec.display_name,
        maturity=spec.maturity.value,
        active=setting is not None and setting.isActive,
        configuration=configuration_status(spec, resolved).value,
        updatedAt=setting.updatedAt if setting else None,
        settingId=setting.id if setting else None,
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
    session: AsyncSession = Depends(get_session),
) -> LLMProviderSettingsResponse:
    env = dict(os.environ)
    settings = await _load_settings(session)
    environment_key = environment_provider_key(env)
    return LLMProviderSettingsResponse(
        activeProvider=next((key for key, row in settings.items() if row.isActive), None),
        environmentProvider=EnvironmentProvider(
            key=environment_key,
            unsupportedValue=None if environment_key else env.get("LLM_PROVIDER"),
        ),
        providers=[_provider_item(spec, env, settings.get(spec.key)) for spec in LLM_PROVIDERS],
    )


class SaveProviderSettingsRequest(BaseModel):
    # Per parameter: a string sets it (blank removes a non-secret; a blank
    # secret is left unchanged), null clears it, an omitted name is left
    # unchanged.
    parameters: dict[str, str | None]


def _is_absolute_http_url(value: str) -> bool:
    if any(character.isspace() for character in value):
        return False
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 -- raises ValueError on a malformed port
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def _validated_changes(spec: ProviderSpec, submitted: dict[str, str | None]) -> dict[str, str | None]:
    """The stored-value change each submitted parameter asks for -- the new
    value, or None to remove it -- with every unchanged parameter left out.
    Raises a 422 without echoing any submitted value."""
    changes: dict[str, str | None] = {}
    for name, raw in submitted.items():
        try:
            parameter = spec.parameter(name)
        except KeyError:
            raise HTTPException(
                status_code=422, detail=f"Unknown parameter {name!r} for provider {spec.key!r}"
            ) from None
        if parameter.secret:
            # Blank means unchanged; storing one waits for encryption (#178).
            if raw is None or raw.strip():
                raise HTTPException(
                    status_code=422, detail=f"Parameter {name!r} is secret and cannot be stored yet"
                )
            continue
        value = (raw or "").strip()
        if not value:
            changes[name] = None
        elif name == "baseUrl" and not _is_absolute_http_url(value):
            raise HTTPException(status_code=422, detail="baseUrl must be an absolute http(s) URL")
        else:
            changes[name] = value
    return changes


@router.put("/{provider_key}", response_model=LLMProviderItem)
async def save_llm_provider_settings(
    provider_key: str,
    req: SaveProviderSettingsRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> LLMProviderItem:
    """Saves a provider's non-secret parameters (issue #175). Saving an
    incomplete configuration is allowed; the setting is created on the first
    change, never for a save that changes nothing. One admin audit event per
    parameter that actually changed, committed with the change."""
    try:
        spec = get_provider_spec(provider_key)
    except KeyError:
        raise HTTPException(status_code=404, detail="LLM provider not found") from None
    changes = _validated_changes(spec, req.parameters)

    setting = (await _load_settings(session)).get(spec.key)
    existing = {row.parameterName: row for row in setting.LLMProviderSettingValue} if setting else {}
    now = _now()
    changed = False
    for name, new_value in changes.items():
        row = existing.get(name)
        old_value = row.value if row else None
        if new_value == old_value:
            continue
        if setting is None:
            setting = LLMProviderSetting(
                id=str(uuid.uuid4()), providerKey=_provider_key(spec), updatedAt=now
            )
            session.add(setting)
        if new_value is None:
            await session.delete(row)
        elif row is None:
            session.add(
                LLMProviderSettingValue(
                    id=str(uuid.uuid4()),
                    settingId=setting.id,
                    parameterName=name,
                    value=new_value,
                    updatedAt=now,
                )
            )
        else:
            row.value = new_value
            row.updatedAt = now
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=None,
            field=f"llmProviderSetting:{spec.key}:{name}",
            old_value="null" if old_value is None else old_value,
            new_value="null" if new_value is None else new_value,
        )
        changed = True
    if changed:
        setting.updatedAt = now
        await session.commit()
        setting = (await _load_settings(session)).get(spec.key)

    return _provider_item(spec, dict(os.environ), setting)
