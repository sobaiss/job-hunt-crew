"""Seeding helpers shared by the tests of the Active LLM provider (#177): the
active-provider setting rows live in real Postgres, and only one row may be
active at a time, so tests wipe them before and after."""

import uuid
from datetime import UTC, datetime

from py_db.models import Llmproviderkey, LLMProviderSetting, LLMProviderSettingValue
from sqlalchemy import delete

LLM_ENV_VARS = (
    "LLM_PROVIDER",
    "LLM_MODEL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "OLLAMA_BASE_URL",
)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def wipe_settings(session_factory) -> None:
    async with session_factory() as session:
        # Values cascade with their setting.
        await session.execute(delete(LLMProviderSetting))
        await session.commit()


async def seed_setting(
    session_factory,
    provider: Llmproviderkey,
    *,
    active: bool = True,
    values: dict[str, str] | None = None,
) -> str:
    setting_id = str(uuid.uuid4())
    async with session_factory() as session:
        session.add(
            LLMProviderSetting(
                id=setting_id, providerKey=provider, isActive=active, updatedAt=_now()
            )
        )
        await session.flush()
        for name, value in (values or {}).items():
            session.add(
                LLMProviderSettingValue(
                    id=str(uuid.uuid4()),
                    settingId=setting_id,
                    parameterName=name,
                    value=value,
                    updatedAt=_now(),
                )
            )
        await session.commit()
    return setting_id
