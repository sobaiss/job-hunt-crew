"""Admin LLM providers (issues #174-#176 and #179, part of the #172 epic,
docs/adr/0024).

Each provider's state is derived from what an Administrator stored in
Postgres, the catalogue and the API's own environment. The API is given the
same LLM-related environment as the workers in docker-compose so this matches
what they actually run on. A secret (an API key) is stored encrypted beside a
plaintext last-four hint; it is never returned, logged, audited or echoed in
an error -- a response reports only whether it is set and that hint, and a
secret supplied by the environment only that it is set.
"""

import os
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from py_db.llm_providers import (
    LLM_PROVIDERS,
    ParameterSource,
    ProviderSpec,
    configuration_status,
    environment_provider_key,
    get_provider_spec,
    resolve_provider_parameters,
)
from py_db.models import Llmproviderkey, LLMProviderSetting, LLMProviderSettingValue
from py_db.quotas import record_admin_audit_event
from py_db.settings_encryption import (
    SettingsEncryptionError,
    decrypt_secret,
    encrypt_secret,
    last_four_hint,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .admin import require_admin
from .db import get_session

ROUTE_PREFIX = "/v1/admin/llm-provider-settings"

router = APIRouter(prefix=ROUTE_PREFIX)

# What the audit trail records for a secret instead of its value (docs/adr/0024).
SECRET_NOT_SET = "(not set)"
SECRET_SET = "(set)"
SECRET_CLEARED = "(cleared)"


async def request_validation_error_without_input(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's default 422 echoes each offending `input` (and `ctx`), which
    for these routes can be a submitted API key. Reports where and why only."""
    return JSONResponse(
        status_code=422,
        content={
            "detail": [
                {"type": error["type"], "loc": error["loc"], "msg": error["msg"]}
                for error in exc.errors()
            ]
        },
    )


class ProviderParameterItem(BaseModel):
    name: str
    secret: bool
    required: bool
    source: str
    # The effective value for a non-secret; always null for a secret.
    value: str | None
    # Whether any source resolves the value -- with lastFour, all a secret reports.
    isSet: bool
    # The last four characters of a stored secret long enough to show them;
    # null for anything else, an environment-supplied secret included.
    lastFour: str | None


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
    """The stored values of `setting` that the catalogue still declares, secrets
    decrypted -- what the workers will resolve. A row for a parameter no longer
    in the catalogue is ignored, and so is a secret that cannot be decrypted
    (missing or rotated key, corrupt payload): it counts as absent, exactly as
    it does for the workers, so the screen never claims a key that will not
    work. `decrypt_secret` logs why."""
    if setting is None:
        return {}
    parameters = {parameter.name: parameter for parameter in spec.parameters}
    values: dict[str, str] = {}
    for row in setting.LLMProviderSettingValue:
        parameter = parameters.get(row.parameterName)
        if parameter is None:
            continue
        if not parameter.secret:
            values[row.parameterName] = row.value
            continue
        secret = decrypt_secret(row.value, provider=spec.key, parameter=parameter.name)
        if secret is not None:
            values[row.parameterName] = secret
    return values


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
    last_fours = {row.parameterName: row.lastFour for row in setting.LLMProviderSettingValue} if setting else {}
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
                lastFour=(
                    last_fours.get(parameter.name)
                    if parameter.secret and resolved[parameter.name].source is ParameterSource.STORED
                    else None
                ),
            )
            for parameter in spec.parameters
        ],
    )


def _unresolved_required(
    spec: ProviderSpec, stored: dict[str, str], env: dict[str, str]
) -> list[str]:
    """Names of `spec`'s required parameters that resolve nowhere -- what
    refuses an activation, and an edit to the active provider."""
    resolved = resolve_provider_parameters(spec, stored, env)
    return [
        parameter.name
        for parameter in spec.parameters
        if parameter.required and resolved[parameter.name].source is ParameterSource.UNRESOLVED
    ]


def _incomplete_error(spec: ProviderSpec, missing: list[str], action: str) -> HTTPException:
    names = ", ".join(missing)
    return HTTPException(
        status_code=422,
        detail=f"Cannot {action} {spec.display_name}: required parameter(s) {names} resolve nowhere",
    )


async def _settings_response(session: AsyncSession) -> LLMProviderSettingsResponse:
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


@router.get("", response_model=LLMProviderSettingsResponse)
async def list_llm_provider_settings(
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> LLMProviderSettingsResponse:
    return await _settings_response(session)


class SaveProviderSettingsRequest(BaseModel):
    # Per parameter: a string sets it (blank removes a non-secret; a blank
    # secret is left unchanged), null clears it, an omitted name is left
    # unchanged. Never logged: it carries secrets.
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
    value, or None to remove it -- with every unchanged parameter left out (a
    blank secret included). Raises a 422 without echoing any submitted value."""
    changes: dict[str, str | None] = {}
    for name, raw in submitted.items():
        try:
            parameter = spec.parameter(name)
        except KeyError:
            raise HTTPException(
                status_code=422, detail=f"Unknown parameter {name!r} for provider {spec.key!r}"
            ) from None
        if parameter.secret:
            if raw is None:
                changes[name] = None
            elif raw.strip():
                changes[name] = raw.strip()
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
    """Saves a provider's parameters (issues #175, #179). Saving an incomplete
    configuration is allowed; the setting is created on the first change, never
    for a save that changes nothing. A submitted secret is encrypted before
    anything is staged, so a write without a usable key fails and stores
    nothing. One admin audit event per parameter that actually changed,
    committed with the change; a secret's event carries markers, never a
    value."""
    try:
        spec = get_provider_spec(provider_key)
    except KeyError:
        raise HTTPException(status_code=404, detail="LLM provider not found") from None
    changes = _validated_changes(spec, req.parameters)
    secrets = {name for name in changes if spec.parameter(name).secret}
    try:
        encrypted = {
            name: encrypt_secret(value)
            for name, value in changes.items()
            if name in secrets and value is not None
        }
    except SettingsEncryptionError as error:
        raise HTTPException(status_code=500, detail=str(error)) from None

    setting = (await _load_settings(session)).get(spec.key)
    existing = {row.parameterName: row for row in setting.LLMProviderSettingValue} if setting else {}
    if setting is not None and setting.isActive:
        # The same rule as activation, applied to the edit: the provider that
        # runs must keep every required parameter resolved.
        after = _stored_values(spec, setting)
        for name, new_value in changes.items():
            if new_value is None:
                after.pop(name, None)
            else:
                after[name] = new_value
        missing = _unresolved_required(spec, after, dict(os.environ))
        if missing:
            raise _incomplete_error(spec, missing, "save")
    now = _now()
    changed = False
    for name, new_value in changes.items():
        row = existing.get(name)
        if name in secrets:
            # Any submitted secret is a change, even the value already stored:
            # the plaintext is never read back to compare. Clearing what was
            # never stored is not.
            if new_value is None and row is None:
                continue
            stored_value = encrypted.get(name)
            hint = last_four_hint(new_value) if new_value is not None else None
            old_audit = SECRET_SET if row else SECRET_NOT_SET
            new_audit = SECRET_CLEARED if new_value is None else SECRET_SET
        else:
            old_value = row.value if row else None
            if new_value == old_value:
                continue
            stored_value, hint = new_value, None
            old_audit = "null" if old_value is None else old_value
            new_audit = "null" if new_value is None else new_value
        if setting is None:
            setting = LLMProviderSetting(
                id=str(uuid.uuid4()), providerKey=_provider_key(spec), updatedAt=now
            )
            session.add(setting)
        if stored_value is None:
            await session.delete(row)
        elif row is None:
            session.add(
                LLMProviderSettingValue(
                    id=str(uuid.uuid4()),
                    settingId=setting.id,
                    parameterName=name,
                    value=stored_value,
                    lastFour=hint,
                    updatedAt=now,
                )
            )
        else:
            row.value = stored_value
            row.lastFour = hint
            row.updatedAt = now
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=None,
            field=f"llmProviderSetting:{spec.key}:{name}",
            old_value=old_audit,
            new_value=new_audit,
        )
        changed = True
    if changed:
        setting.updatedAt = now
        await session.commit()
        setting = (await _load_settings(session)).get(spec.key)

    return _provider_item(spec, dict(os.environ), setting)


def _record_active_change(
    session: AsyncSession, admin_id: str, old: str | None, new: str | None
) -> None:
    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=None,
        field="llmProviderSetting:active",
        old_value=old or "none",
        new_value=new or "none",
    )


@router.post("/deactivate", response_model=LLMProviderSettingsResponse)
async def deactivate_llm_provider(
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> LLMProviderSettingsResponse:
    """Hands control back to the environment (issue #176). Nothing to do, and
    no audit event, when no provider is active."""
    settings = await _load_settings(session)
    current = next((row for row in settings.values() if row.isActive), None)
    if current is not None:
        current.isActive = False
        current.updatedAt = _now()
        _record_active_change(session, admin_id, current.providerKey.value.lower(), None)
        await session.commit()
    return await _settings_response(session)


@router.post("/{provider_key}/activate", response_model=LLMProviderSettingsResponse)
async def activate_llm_provider(
    provider_key: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> LLMProviderSettingsResponse:
    """Makes a provider the only active one (issue #176), creating its setting
    if it has none. Refused with a 422 naming every required parameter that
    resolves nowhere; activating the active provider is a no-op. Activation is
    never blocked or confirmed on maturity -- the badge is informational."""
    try:
        spec = get_provider_spec(provider_key)
    except KeyError:
        raise HTTPException(status_code=404, detail="LLM provider not found") from None

    settings = await _load_settings(session)
    target = settings.get(spec.key)
    if target is not None and target.isActive:
        return await _settings_response(session)
    missing = _unresolved_required(spec, _stored_values(spec, target), dict(os.environ))
    if missing:
        raise _incomplete_error(spec, missing, "activate")

    now = _now()
    current = next((row for row in settings.values() if row.isActive), None)
    if current is not None:
        current.isActive = False
        current.updatedAt = now
        # Flushed first: the partial unique index allows one active row at any
        # moment, and the unit of work does not order two UPDATEs for us.
        await session.flush()
    if target is None:
        target = LLMProviderSetting(
            id=str(uuid.uuid4()), providerKey=_provider_key(spec), isActive=True, updatedAt=now
        )
        session.add(target)
    else:
        target.isActive = True
        target.updatedAt = now
    _record_active_change(
        session, admin_id, current.providerKey.value.lower() if current else None, spec.key
    )
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent activation won the race for the single active slot.
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="Another provider was activated at the same time; try again"
        ) from None
    return await _settings_response(session)
