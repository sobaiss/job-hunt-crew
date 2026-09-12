"""Per-user daily analysis cap (issue #33).

The rule — at most `DAILY_ANALYSIS_CAP` (default 50) `Analysis` rows per user
per UTC day, counted by `requestedAt` — is enforced in two places:
synchronously by `POST /v1/analyses` (services/api) and by the ingestion
fan-out that turns a multi-offer `IngestionJob` into `Analysis` rows
(`create_analyses_for_ready_offers` in services/ingestion). This module is
their single source of truth so the two can never drift.

Hand-written (not sqlacodegen output), like `pipeline_events.py`.
"""

import os
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Analysis, GeneratedDocument

DEFAULT_DAILY_ANALYSIS_CAP = 50
DEFAULT_DAILY_GENERATION_CAP = 20


def daily_analysis_cap() -> int:
    """`DAILY_ANALYSIS_CAP` from the environment, or
    `DEFAULT_DAILY_ANALYSIS_CAP` when it is unset, non-numeric, or not a
    positive integer.
    """
    raw = os.environ.get("DAILY_ANALYSIS_CAP")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_DAILY_ANALYSIS_CAP


def _start_of_today() -> datetime:
    # Analysis.requestedAt is TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime);
    # asyncpg rejects tz-aware values against it, so strip tzinfo after
    # computing midnight in UTC.
    return datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


async def analyses_requested_today(session: AsyncSession, user_id: str) -> int:
    """How many `Analysis` rows `user_id` has requested since 00:00 UTC today."""
    count = await session.scalar(
        select(func.count())
        .select_from(Analysis)
        .where(Analysis.userId == user_id, Analysis.requestedAt >= _start_of_today())
    )
    return count or 0


async def remaining_daily_analyses(session: AsyncSession, user_id: str) -> int:
    """Slots left in `user_id`'s daily budget: `cap - used`, floored at 0."""
    used = await analyses_requested_today(session, user_id)
    return max(daily_analysis_cap() - used, 0)


def daily_generation_cap() -> int:
    """`DAILY_GENERATION_CAP` from the environment, or
    `DEFAULT_DAILY_GENERATION_CAP` when it is unset, non-numeric, or not a
    positive integer. Separate budget from `daily_analysis_cap` (issue #58's
    "Regenerate ... bounded by a daily cap (default 20)").
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
