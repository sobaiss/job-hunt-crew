"""Plan/QuotaKind effective-quota resolution (issue #135, docs/adr/0013,
docs/adr/0014).

`effective_quota` is the single shared resolution point every quota-consuming
action (Scout create/reactivate today; Analysis and GeneratedDocument
call sites follow in #136/#137) reads its ceiling from: a User's
`QuotaOverride` for a `QuotaKind` when one exists, else their Plan's
`PlanQuotaDefault`, live — not a value copied at signup. `None` means
unlimited. This replaces the flat, global env-var caps (`MAX_SCOUTS_PER_USER`,
`DAILY_ANALYSIS_CAP`, `DAILY_GENERATION_CAP`) that applied identically to
every User regardless of Plan.

Hand-written (not sqlacodegen output), like `quota.py`.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    PlanQuotaDefault,
    QuotaAuditEvent,
    Quotakind,
    QuotaOverride,
    Scout,
    Scoutstatus,
    User,
)


async def effective_quota(session: AsyncSession, user_id: str, kind: Quotakind) -> int | None:
    """The ceiling actually enforced for `user_id` on `kind`: their
    `QuotaOverride.limit` if a `QuotaOverride` row exists for (user_id, kind)
    — including when that row's `limit` is itself `None` (explicitly
    unlimited) — else the `user_id`'s Plan's `PlanQuotaDefault.limit`. `None`
    at either level means unlimited.
    """
    override = await session.scalar(
        select(QuotaOverride).where(
            QuotaOverride.userId == user_id, QuotaOverride.quotaKind == kind
        )
    )
    if override is not None:
        return override.limit

    plan = await session.scalar(select(User.plan).where(User.id == user_id))
    default = await session.scalar(
        select(PlanQuotaDefault).where(
            PlanQuotaDefault.plan == plan, PlanQuotaDefault.quotaKind == kind
        )
    )
    return default.limit if default is not None else None


async def active_scout_count(
    session: AsyncSession, user_id: str, *, exclude_id: str | None = None
) -> int:
    """How many of `user_id`'s Scouts are currently `ACTIVE`. Moved here from
    `services/api`'s `_active_scout_count` so it sits alongside the resolver
    that now gates it (`QuotaKind.ACTIVE_SCOUTS`), matching how the other
    QuotaKind counters already live in `py_db` rather than in `v1.py`.
    """
    stmt = select(func.count()).select_from(Scout).where(
        Scout.userId == user_id, Scout.status == Scoutstatus.ACTIVE
    )
    if exclude_id is not None:
        stmt = stmt.where(Scout.id != exclude_id)
    return int((await session.scalar(stmt)) or 0)


async def total_active_scout_count(session: AsyncSession) -> int:
    """How many `Scout` rows, across every User, are currently `ACTIVE` — the
    platform-wide counterpart of `active_scout_count`, for the admin stats
    endpoint (issue #140).
    """
    stmt = select(func.count()).select_from(Scout).where(Scout.status == Scoutstatus.ACTIVE)
    return int((await session.scalar(stmt)) or 0)


def record_quota_audit_event(
    session: AsyncSession,
    *,
    actor_user_id: str,
    target_user_id: str | None,
    field: str,
    old_value: str | None,
    new_value: str | None,
) -> QuotaAuditEvent:
    """Stages one QuotaAuditEvent row for an Administrator's edit to a
    QuotaOverride, a PlanQuotaDefault, or a User's Plan (issue #138).

    Unlike `record_pipeline_event`, this does not commit: every admin
    mutation (#139/#140) must write its audit event in the same transaction
    as the change it records, so a caller adds this row alongside its own
    changes and commits once.
    """
    event = QuotaAuditEvent(
        id=str(uuid.uuid4()),
        actorUserId=actor_user_id,
        targetUserId=target_user_id,
        field=field,
        oldValue=old_value,
        newValue=new_value,
    )
    session.add(event)
    return event
