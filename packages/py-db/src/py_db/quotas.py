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
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    AdminAuditEvent,
    Plan,
    PlanQuotaDefault,
    QuotaAlert,
    Quotaalertthreshold,
    Quotakind,
    QuotaOverride,
    Scout,
    Scoutstatus,
    Subscription,
)

# Fraction of an Effective quota at which a QuotaAlert.APPROACHING fires
# (issue #142). 100%+ always fires QuotaAlert.EXCEEDED regardless of this.
_APPROACHING_RATIO = 0.8


async def effective_plan(session: AsyncSession, user_id: str) -> Plan:
    """The Plan actually in force for `user_id` right now (docs/adr/0018):
    their most recent Subscription's `plan` if its period covers now
    (`startDate <= now` and `endDate` is `None` or in the future), else
    `free`. Computed live on every call — never cached on User, never
    backfilled by a background job. A User with no Subscription at all
    (shouldn't happen once #154 lands, but not assumed here) also gets `free`.
    """
    subscription = await session.scalar(
        select(Subscription)
        .where(Subscription.userId == user_id)
        .order_by(Subscription.startDate.desc(), Subscription.createdAt.desc())
        .limit(1)
    )
    if subscription is None:
        return Plan.FREE

    now = datetime.now(UTC).replace(tzinfo=None)
    if subscription.startDate > now:
        return Plan.FREE
    if subscription.endDate is not None and subscription.endDate <= now:
        return Plan.FREE
    return subscription.plan


async def effective_quota(session: AsyncSession, user_id: str, kind: Quotakind) -> int | None:
    """The ceiling actually enforced for `user_id` on `kind`: their
    `QuotaOverride.limit` if a `QuotaOverride` row exists for (user_id, kind)
    — including when that row's `limit` is itself `None` (explicitly
    unlimited) — else the `user_id`'s Effective Plan's
    `PlanQuotaDefault.limit`. `None` at either level means unlimited.
    """
    override = await session.scalar(
        select(QuotaOverride).where(
            QuotaOverride.userId == user_id, QuotaOverride.quotaKind == kind
        )
    )
    if override is not None:
        return override.limit

    plan = await effective_plan(session, user_id)
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


def record_admin_audit_event(
    session: AsyncSession,
    *,
    actor_user_id: str,
    target_user_id: str | None,
    field: str | None = None,
    old_value: str | None = None,
    new_value: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
) -> AdminAuditEvent:
    """Stages one AdminAuditEvent row for an Administrator's action against a
    User or a global setting (issue #138; renamed from
    record_quota_audit_event in #144 as the field vocabulary grew beyond
    quotas — isAdmin, blockedAt, name, ...), or against a candidate's own
    resource -- an Analysis, a Scout, a CVVersion (issue #159, docs/adr/0020).
    Callers pass either `field`/`old_value`/`new_value` for a field edit, or
    `resource_type`/`resource_id` for a resource action -- never both.

    Unlike `record_pipeline_event`, this does not commit: every admin
    mutation (#139/#140) must write its audit event in the same transaction
    as the change it records, so a caller adds this row alongside its own
    changes and commits once.
    """
    event = AdminAuditEvent(
        id=str(uuid.uuid4()),
        actorUserId=actor_user_id,
        targetUserId=target_user_id,
        field=field,
        oldValue=old_value,
        newValue=new_value,
        resourceType=resource_type,
        resourceId=resource_id,
    )
    session.add(event)
    return event


def _threshold_for(cap: int | None, used: int) -> Quotaalertthreshold | None:
    """Which threshold `used` sits at/over for `cap`, or `None` when under
    80% or `cap` is unlimited. `used` may be <= 0 (the "before this action"
    probe in `maybe_record_quota_alert`), which always resolves to `None`.
    """
    if cap is None or cap <= 0 or used <= 0:
        return None
    if used >= cap:
        return Quotaalertthreshold.EXCEEDED
    if used >= cap * _APPROACHING_RATIO:
        return Quotaalertthreshold.APPROACHING
    return None


async def maybe_record_quota_alert(
    session: AsyncSession,
    user_id: str,
    kind: Quotakind,
    *,
    cap: int | None,
    used_after: int,
) -> QuotaAlert | None:
    """Stages one QuotaAlert row iff `used_after` (the counter's value right
    after the quota-consuming write that just happened) newly crosses the
    80% (APPROACHING) or 100%+ (EXCEEDED) threshold for `cap` — issue #142.

    Every quota-consuming action here increments its counter by exactly one
    unit per call, so `used_after - 1` is the counter's value immediately
    before this action. Comparing the threshold implied by each side is
    enough to detect the crossing: if both resolve to the same threshold (or
    both `None`), usage was already there (or still under 80%) and nothing is
    inserted — this is what keeps a Candidate who stays over their limit from
    getting a fresh alert on every subsequent request.

    Does not commit, matching `record_quota_audit_event` — the caller commits
    once alongside its own write.
    """
    new_threshold = _threshold_for(cap, used_after)
    if new_threshold is None:
        return None
    if _threshold_for(cap, used_after - 1) == new_threshold:
        return None

    alert = QuotaAlert(
        id=str(uuid.uuid4()),
        userId=user_id,
        quotaKind=kind,
        threshold=new_threshold,
    )
    session.add(alert)
    return alert
