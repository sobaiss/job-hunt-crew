"""Per-user Analysis/GeneratedDocument usage counters (issue #33, extended by
#136 and #137).

`analyses_requested_today`, `analyses_requested_this_month`, and
`generated_documents_created_today` are read by `POST /v1/analyses`
(services/api), the `.../generated-documents` create/regenerate routes, and
the ingestion fan-out that turns a multi-offer `IngestionJob` into `Analysis`
rows (`create_analyses_for_ready_offers` in services/ingestion) against the
ceilings `py_db.quotas.effective_quota` resolves for `QuotaKind.ANALYSES_DAILY`
/ `QuotaKind.ANALYSES_MONTHLY` / `QuotaKind.DOCUMENTS_DAILY` — this module is
their single source of truth for the *usage* side of that comparison, so the
call sites can never drift. The caps themselves no longer live here (see
`py_db.quotas`); the flat `DAILY_ANALYSIS_CAP`/`DAILY_GENERATION_CAP` env vars
this module used to read are retired (docs/adr/0014).

Hand-written (not sqlacodegen output), like `pipeline_events.py`.
"""

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Analysis, GeneratedDocument


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
