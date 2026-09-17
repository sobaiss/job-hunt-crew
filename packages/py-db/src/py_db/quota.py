"""Per-user Analysis usage counters (issue #33, extended by #136).

`analyses_requested_today` and `analyses_requested_this_month` are read by
`POST /v1/analyses` (services/api) and by the ingestion fan-out that turns a
multi-offer `IngestionJob` into `Analysis` rows
(`create_analyses_for_ready_offers` in services/ingestion) against the
ceilings `py_db.quotas.effective_quota` resolves for `QuotaKind.ANALYSES_DAILY`
/ `QuotaKind.ANALYSES_MONTHLY` — this module is their single source of truth
for the *usage* side of that comparison, so the two call sites can never
drift. The caps themselves no longer live here (see `py_db.quotas`); the flat
`DAILY_ANALYSIS_CAP` env var this module used to read is retired
(docs/adr/0014).

Hand-written (not sqlacodegen output), like `pipeline_events.py`.
"""

import os
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Analysis, GeneratedDocument

DEFAULT_DAILY_GENERATION_CAP = 20


def _start_of_today() -> datetime:
    # Analysis.requestedAt is TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime);
    # asyncpg rejects tz-aware values against it, so strip tzinfo after
    # computing midnight in UTC.
    return datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


def _start_of_month() -> datetime:
    return _start_of_today().replace(day=1)


async def analyses_requested_today(session: AsyncSession, user_id: str) -> int:
    """How many `Analysis` rows `user_id` has requested since 00:00 UTC today."""
    count = await session.scalar(
        select(func.count())
        .select_from(Analysis)
        .where(Analysis.userId == user_id, Analysis.requestedAt >= _start_of_today())
    )
    return count or 0


async def analyses_requested_this_month(session: AsyncSession, user_id: str) -> int:
    """How many `Analysis` rows `user_id` has requested since 00:00 UTC on the
    1st of the current UTC month (issue #136)."""
    count = await session.scalar(
        select(func.count())
        .select_from(Analysis)
        .where(Analysis.userId == user_id, Analysis.requestedAt >= _start_of_month())
    )
    return count or 0


def daily_generation_cap() -> int:
    """`DAILY_GENERATION_CAP` from the environment, or
    `DEFAULT_DAILY_GENERATION_CAP` when it is unset, non-numeric, or not a
    positive integer. Separate budget from the Analysis counters above (issue
    #58's "Regenerate ... bounded by a daily cap (default 20)"). Slated to
    move onto the Plan/QuotaKind system in #137, same as the Analysis caps
    did in #136.
    """
    raw = os.environ.get("DAILY_GENERATION_CAP")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_DAILY_GENERATION_CAP


async def generated_documents_created_today(session: AsyncSession, user_id: str) -> int:
    """How many `GeneratedDocument` rows have been created for `user_id`
    since 00:00 UTC today. `GeneratedDocument` has no direct `userId` column,
    so this joins through its owning `Analysis`.
    """
    count = await session.scalar(
        select(func.count())
        .select_from(GeneratedDocument)
        .join(Analysis, Analysis.id == GeneratedDocument.analysisId)
        .where(Analysis.userId == user_id, GeneratedDocument.createdAt >= _start_of_today())
    )
    return count or 0
