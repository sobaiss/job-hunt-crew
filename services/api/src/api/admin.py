import json
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from py_db.models import (
    AdminAuditEvent,
    Analysis,
    Analysisstatus,
    Application,
    Applicationstatus,
    CVVersion,
    Cvconversionstatus,
    Duration,
    GeneratedDocument,
    Generateddocumentstatus,
    Generateddocumenttype,
    IngestionJob,
    JobOffer,
    Plan,
    PlanQuotaDefault,
    Quotakind,
    QuotaOverride,
    Role,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    Subscription,
    User,
)
from py_db.quota import (
    analyses_requested_this_month,
    analyses_requested_today,
    generated_documents_created_today,
    total_analyses_requested_this_month,
    total_analyses_requested_today,
    total_generated_documents_created_today,
)
from py_db.quotas import (
    active_scout_count,
    effective_plan,
    effective_quota,
    record_admin_audit_event,
    total_active_scout_count,
)
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .sqs_client import (
    ANALYSIS_INTAKE_QUEUE_URL,
    CV_CONVERSION_QUEUE_URL,
    GENERATION_INTAKE_QUEUE_URL,
    SCOUT_INTAKE_QUEUE_URL,
    make_sqs_client,
)

router = APIRouter(prefix="/v1/admin")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# Same env var and default as `v1._scout_run_rate_limit` (issue #162) -- an
# admin-triggered run still hits the same scraped sites, so it shares the
# one-per-hour throttle rather than getting its own, separate budget.
DEFAULT_SCOUT_RUN_RATE_LIMIT_SECONDS = 3600


def _scout_run_rate_limit() -> timedelta:
    raw = os.environ.get("SCOUT_RUN_RATE_LIMIT_SECONDS")
    try:
        parsed = int(raw) if raw is not None else None
    except ValueError:
        parsed = None
    seconds = parsed if parsed is not None and parsed >= 0 else DEFAULT_SCOUT_RUN_RATE_LIMIT_SECONDS
    return timedelta(seconds=seconds)


async def require_admin(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_role: str | None = Header(default=None, alias="X-User-Role"),
) -> str:
    """Rejects any caller whose forwarded Role isn't Administrator (issue
    #156, replacing the `isAdmin` boolean gate from #138/#144 per
    docs/adr/0017). Trusts the BFF-forwarded X-User-Role header the same way
    `require_user_id` trusts X-User-Id — no independent re-verification
    against Postgres, same MVP boundary as the Internal API secret.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    if x_user_role != Role.ADMINISTRATOR.value:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return x_user_id


class AdminMeResponse(BaseModel):
    userId: str
    plan: str
    role: str


@router.get("/me", response_model=AdminMeResponse)
async def admin_me(
    user_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminMeResponse:
    """Backs the bare `/admin` landing page (issue #138) — confirms the
    caller actually cleared `require_admin`, and reports their real Effective
    Plan now that admin access no longer implies one (#144), plus their Role
    (issue #156, replacing the `isAdmin` boolean per docs/adr/0017).
    """
    target = await _get_target_user(session, user_id)
    plan = await effective_plan(session, user_id)
    return AdminMeResponse(userId=target.id, plan=plan.value, role=target.role.value)


async def _get_target_user(session: AsyncSession, user_id: str) -> User:
    target = await session.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")
    return target


async def _usage_for(session: AsyncSession, user_id: str, kind: Quotakind) -> int:
    if kind == Quotakind.ACTIVE_SCOUTS:
        return await active_scout_count(session, user_id)
    if kind == Quotakind.ANALYSES_DAILY:
        return await analyses_requested_today(session, user_id)
    if kind == Quotakind.ANALYSES_MONTHLY:
        return await analyses_requested_this_month(session, user_id)
    return await generated_documents_created_today(session, user_id)


class QuotaUsage(BaseModel):
    cap: int | None
    used: int
    remaining: int | None
    hasOverride: bool


class UserQuotasResponse(BaseModel):
    userId: str
    name: str | None
    email: str | None
    plan: str
    planEndDate: datetime | None
    role: str
    blocked: bool
    createdAt: datetime
    quotas: dict[str, QuotaUsage]


async def _current_subscription(session: AsyncSession, user_id: str) -> Subscription | None:
    """The Subscription actively covering `user_id` right now, if any (issue
    #155, docs/adr/0018) -- the same date-covering rule as `effective_plan`,
    but returns the row itself so callers can end it or read its `endDate`.
    """
    now = _now()
    return await session.scalar(
        select(Subscription)
        .where(
            Subscription.userId == user_id,
            Subscription.startDate <= now,
            or_(Subscription.endDate.is_(None), Subscription.endDate > now),
        )
        .order_by(Subscription.startDate.desc(), Subscription.createdAt.desc())
        .limit(1)
    )


async def _user_quota_summary(
    session: AsyncSession, user_id: str
) -> tuple[dict[str, QuotaUsage], bool]:
    """Effective quota + usage for every QuotaKind for `user_id`, and whether
    any of them is currently at or over its cap — the shared computation
    behind the per-user detail screen (#139) and the admin user list/stats
    endpoints (#140), so "at/over any limit" is decided in exactly one place.
    """
    override_kinds = set(
        (
            await session.scalars(
                select(QuotaOverride.quotaKind).where(QuotaOverride.userId == user_id)
            )
        ).all()
    )

    quotas: dict[str, QuotaUsage] = {}
    at_or_over_limit = False
    for kind in Quotakind:
        cap = await effective_quota(session, user_id, kind)
        used = await _usage_for(session, user_id, kind)
        quotas[kind.value] = QuotaUsage(
            cap=cap,
            used=used,
            remaining=None if cap is None else max(cap - used, 0),
            hasOverride=kind in override_kinds,
        )
        if cap is not None and used >= cap:
            at_or_over_limit = True

    return quotas, at_or_over_limit


@router.get("/users/{user_id}/quotas", response_model=UserQuotasResponse)
async def get_user_quotas(
    user_id: str,
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> UserQuotasResponse:
    """A target User's info, Plan, Effective quota, current usage, and which
    QuotaKinds carry an explicit `QuotaOverride`, for the User panel (issue
    #147, relocated from the now-deleted per-user page of issue #139).
    """
    target = await _get_target_user(session, user_id)
    quotas, _ = await _user_quota_summary(session, user_id)
    plan = await effective_plan(session, user_id)
    current = await _current_subscription(session, user_id)
    return UserQuotasResponse(
        userId=target.id,
        name=target.name,
        email=target.email,
        plan=plan.value,
        planEndDate=current.endDate if current else None,
        role=target.role.value,
        blocked=target.blockedAt is not None,
        createdAt=target.createdAt,
        quotas=quotas,
    )


class SetQuotaOverrideRequest(BaseModel):
    limit: int | None = None


class QuotaOverrideResponse(BaseModel):
    quotaKind: str
    limit: int | None


@router.put(
    "/users/{user_id}/quota-overrides/{kind}", response_model=QuotaOverrideResponse
)
async def set_quota_override(
    user_id: str,
    kind: Quotakind,
    req: SetQuotaOverrideRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> QuotaOverrideResponse:
    """Sets (creating or replacing) `user_id`'s `QuotaOverride` for `kind`,
    taking precedence over their Plan's default per `effective_quota`'s
    resolution order — `limit: null` makes that QuotaKind unlimited for this
    User specifically (issue #139). Writes one `AdminAuditEvent` in the same
    transaction as the change.
    """
    await _get_target_user(session, user_id)

    existing = await session.scalar(
        select(QuotaOverride).where(
            QuotaOverride.userId == user_id, QuotaOverride.quotaKind == kind
        )
    )
    old_value = None
    if existing is not None:
        old_value = "null" if existing.limit is None else str(existing.limit)
        existing.limit = req.limit
        existing.updatedAt = _now()
    else:
        session.add(
            QuotaOverride(
                id=str(uuid.uuid4()),
                userId=user_id,
                quotaKind=kind,
                limit=req.limit,
                updatedAt=_now(),
            )
        )

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=user_id,
        field=f"quotaOverride:{kind.value}",
        old_value=old_value,
        new_value="null" if req.limit is None else str(req.limit),
    )
    await session.commit()

    return QuotaOverrideResponse(quotaKind=kind.value, limit=req.limit)


@router.delete("/users/{user_id}/quota-overrides/{kind}", status_code=204)
async def delete_quota_override(
    user_id: str,
    kind: Quotakind,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Clears `user_id`'s `QuotaOverride` for `kind`, reverting them to
    following their Plan's default (issue #139). Idempotent: a target with no
    override for `kind` already reads as cleared, so this is a no-op with no
    audit event when none exists — only an actual removal is audited.
    """
    await _get_target_user(session, user_id)

    existing = await session.scalar(
        select(QuotaOverride).where(
            QuotaOverride.userId == user_id, QuotaOverride.quotaKind == kind
        )
    )
    if existing is None:
        return

    old_value = "null" if existing.limit is None else str(existing.limit)
    await session.delete(existing)
    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=user_id,
        field=f"quotaOverride:{kind.value}",
        old_value=old_value,
        new_value=None,
    )
    await session.commit()


class SetPlanRequest(BaseModel):
    plan: Plan
    duration: Duration | None = None


class SetPlanResponse(BaseModel):
    userId: str
    plan: str
    endDate: datetime | None = None


def _duration_days(duration: Duration) -> int:
    return 30 if duration == Duration.MONTHLY else 365


def _subscription_label(plan: Plan, duration: Duration | None) -> str:
    return plan.value if duration is None else f"{plan.value}:{duration.value}"


@router.put("/users/{user_id}/plan", response_model=SetPlanResponse)
async def set_user_plan(
    user_id: str,
    req: SetPlanRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SetPlanResponse:
    """Assigns or renews `user_id`'s Subscription (issue #155, docs/adr/0018)
    — creates a new Subscription for `req.plan`, ending whichever one they
    currently hold so a User is never on two Plans at once. `duration` is
    required for STANDARD/PREMIUM (the server computes `endDate` from it,
    never accepted from the client) and rejected for FREE, whose
    Subscription is always unbounded. There is no separate renew endpoint —
    calling this again with the same or a different plan/duration is how a
    Subscription gets renewed. Re-assigning the exact same still-active
    plan/duration is a no-op that writes no `AdminAuditEvent`, matching
    `delete_quota_override`'s idempotency.
    """
    await _get_target_user(session, user_id)

    if req.plan in (Plan.STANDARD, Plan.PREMIUM):
        if req.duration is None:
            raise HTTPException(
                status_code=400, detail="duration is required for the Standard/Premium plans"
            )
    elif req.duration is not None:
        raise HTTPException(
            status_code=400, detail="duration is only accepted for the Standard/Premium plans"
        )

    current = await _current_subscription(session, user_id)

    if current is not None and current.plan == req.plan and current.duration == req.duration:
        return SetPlanResponse(userId=user_id, plan=current.plan.value, endDate=current.endDate)

    now = _now()
    old_value = _subscription_label(current.plan, current.duration) if current else "FREE"

    if current is not None:
        current.endDate = now

    new_subscription = Subscription(
        id=str(uuid.uuid4()),
        userId=user_id,
        plan=req.plan,
        startDate=now,
        duration=req.duration,
        endDate=now + timedelta(days=_duration_days(req.duration)) if req.duration else None,
    )
    session.add(new_subscription)

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=user_id,
        field="plan",
        old_value=old_value,
        new_value=_subscription_label(req.plan, req.duration),
    )
    await session.commit()

    return SetPlanResponse(
        userId=user_id, plan=new_subscription.plan.value, endDate=new_subscription.endDate
    )


class SetUserBlockedRequest(BaseModel):
    blocked: bool


class SetUserBlockedResponse(BaseModel):
    userId: str
    blocked: bool


@router.put("/users/{user_id}/blocked", response_model=SetUserBlockedResponse)
async def set_user_blocked(
    user_id: str,
    req: SetUserBlockedRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SetUserBlockedResponse:
    """Blocks or unblocks `user_id` (issue #148) — enforced live on every
    subsequent `/v1/*` request by `require_user_id` (#144/docs/adr/0016), not
    just gated here. An Administrator can never block themselves, since that
    would deny their own access with no way back in. A no-op request (the
    User already in the requested state) writes no `AdminAuditEvent`, matching
    `set_user_plan`'s idempotency.
    """
    if user_id == admin_id:
        raise HTTPException(status_code=400, detail="Administrators cannot block themselves")

    target = await _get_target_user(session, user_id)
    currently_blocked = target.blockedAt is not None

    if req.blocked != currently_blocked:
        old_value = target.blockedAt.isoformat() if target.blockedAt else "null"
        target.blockedAt = _now() if req.blocked else None
        target.updatedAt = _now()
        new_value = target.blockedAt.isoformat() if target.blockedAt else "null"
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=user_id,
            field="blockedAt",
            old_value=old_value,
            new_value=new_value,
        )
        await session.commit()

    return SetUserBlockedResponse(userId=target.id, blocked=target.blockedAt is not None)


class SetUserInfoRequest(BaseModel):
    name: str


class SetUserInfoResponse(BaseModel):
    userId: str
    name: str | None


@router.put("/users/{user_id}/info", response_model=SetUserInfoResponse)
async def set_user_info(
    user_id: str,
    req: SetUserInfoRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SetUserInfoResponse:
    """Edits `user_id`'s display name from the User panel (issue #149) —
    email stays read-only and is never accepted here (the request model has
    no `email` field, so one sent by a caller is simply ignored). A no-op
    request (the same name already set) writes no `AdminAuditEvent`, matching
    `set_user_plan`'s idempotency.
    """
    target = await _get_target_user(session, user_id)

    if req.name != target.name:
        old_value = "null" if target.name is None else target.name
        target.name = req.name
        target.updatedAt = _now()
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=user_id,
            field="name",
            old_value=old_value,
            new_value=req.name,
        )
        await session.commit()

    return SetUserInfoResponse(userId=target.id, name=target.name)


class SetUserRoleRequest(BaseModel):
    role: Role


class SetUserRoleResponse(BaseModel):
    userId: str
    role: str


@router.put("/users/{user_id}/role", response_model=SetUserRoleResponse)
async def set_user_role(
    user_id: str,
    req: SetUserRoleRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SetUserRoleResponse:
    """Sets `user_id`'s Role to External/Internal/Administrator (issue #156,
    replacing the `isAdmin` grant/revoke from #149 per docs/adr/0017). An
    Administrator can never change their own Role away from Administrator,
    since that would lock them out of the Admin area with no way back in —
    only that direction is rejected for a self-target, since setting
    Administrator on themselves is already the caller's own state (every
    caller here already cleared `require_admin`) and resolves as a harmless
    no-op. A no-op request (the User already in the requested Role) writes
    no `AdminAuditEvent`, matching `set_user_plan`'s idempotency.
    """
    if user_id == admin_id and req.role != Role.ADMINISTRATOR:
        raise HTTPException(
            status_code=400,
            detail="Administrators cannot change their own role away from administrator",
        )

    target = await _get_target_user(session, user_id)

    if req.role != target.role:
        old_value = target.role.value
        target.role = req.role
        target.updatedAt = _now()
        new_value = target.role.value
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=user_id,
            field="role",
            old_value=old_value,
            new_value=new_value,
        )
        await session.commit()

    return SetUserRoleResponse(userId=target.id, role=target.role.value)


class AuditEventActor(BaseModel):
    id: str
    name: str | None
    email: str | None


class AuditEventItem(BaseModel):
    id: str
    field: str
    oldValue: str | None
    newValue: str | None
    createdAt: datetime
    actor: AuditEventActor


class AuditEventsResponse(BaseModel):
    events: list[AuditEventItem]


@router.get("/users/{user_id}/audit-events", response_model=AuditEventsResponse)
async def get_audit_events(
    user_id: str,
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AuditEventsResponse:
    """Every `AdminAuditEvent` recorded against `user_id`, newest first, for
    the User panel's Audit history tab (issue #150) — quota overrides, Plan
    changes, blocks/unblocks, info edits, and role changes all land here
    since they all write through `record_admin_audit_event`. The acting
    Administrator's name/email is resolved here so the frontend never has to
    do its own per-event lookup.
    """
    await _get_target_user(session, user_id)

    rows = (
        await session.scalars(
            select(AdminAuditEvent)
            .where(AdminAuditEvent.targetUserId == user_id)
            .order_by(AdminAuditEvent.createdAt.desc())
        )
    ).all()

    actor_ids = {row.actorUserId for row in rows}
    actors: dict[str, User] = {}
    if actor_ids:
        actor_rows = (
            await session.scalars(select(User).where(User.id.in_(actor_ids)))
        ).all()
        actors = {actor.id: actor for actor in actor_rows}

    events = []
    for row in rows:
        actor = actors.get(row.actorUserId)
        events.append(
            AuditEventItem(
                id=row.id,
                field=row.field,
                oldValue=row.oldValue,
                newValue=row.newValue,
                createdAt=row.createdAt,
                actor=AuditEventActor(
                    id=row.actorUserId,
                    name=actor.name if actor else None,
                    email=actor.email if actor else None,
                ),
            )
        )

    return AuditEventsResponse(events=events)


class PlanQuotaDefaultItem(BaseModel):
    plan: str
    quotaKind: str
    limit: int | None


class PlanQuotaDefaultsResponse(BaseModel):
    defaults: list[PlanQuotaDefaultItem]


@router.get("/plan-defaults", response_model=PlanQuotaDefaultsResponse)
async def get_plan_defaults(
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> PlanQuotaDefaultsResponse:
    """Every `PlanQuotaDefault` row (4 Plans x 4 QuotaKinds, seeded by the
    #134 migration) for the admin plan-defaults editor (issue #140).
    """
    rows = (await session.scalars(select(PlanQuotaDefault))).all()
    return PlanQuotaDefaultsResponse(
        defaults=[
            PlanQuotaDefaultItem(plan=row.plan.value, quotaKind=row.quotaKind.value, limit=row.limit)
            for row in rows
        ]
    )


class SetPlanQuotaDefaultsRequest(BaseModel):
    limits: dict[Quotakind, int | None]


@router.put("/plan-defaults/{plan}", response_model=PlanQuotaDefaultsResponse)
async def set_plan_defaults(
    plan: Plan,
    req: SetPlanQuotaDefaultsRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> PlanQuotaDefaultsResponse:
    """Edits every QuotaKind ceiling for `plan` together, in one action
    (issue #146) — replaces the old per-kind endpoint so the Plan defaults
    page's slide-over form can save all four limits at once. Reaches every
    User on `plan` with no `QuotaOverride` for a changed kind on their very
    next `effective_quota` read — no backfill needed, since that resolution
    always reads this row live (docs/adr/0013). Only kinds whose limit
    actually changes write an `AdminAuditEvent`, matching `set_user_plan`'s
    per-field idempotency; a `plan` with no `PlanQuotaDefault` rows 404s
    (defensive only — every current `Plan` value is seeded with rows).
    """
    rows = (
        await session.scalars(select(PlanQuotaDefault).where(PlanQuotaDefault.plan == plan))
    ).all()
    if not rows:
        raise HTTPException(status_code=404, detail="PlanQuotaDefault not found")

    changed = False
    for row in rows:
        if row.quotaKind not in req.limits:
            continue
        new_limit = req.limits[row.quotaKind]
        if row.limit != new_limit:
            old_value = "null" if row.limit is None else str(row.limit)
            row.limit = new_limit
            row.updatedAt = _now()
            record_admin_audit_event(
                session,
                actor_user_id=admin_id,
                target_user_id=None,
                field=f"planQuotaDefault:{plan.value}:{row.quotaKind.value}",
                old_value=old_value,
                new_value="null" if new_limit is None else str(new_limit),
            )
            changed = True
    if changed:
        await session.commit()

    return PlanQuotaDefaultsResponse(
        defaults=[
            PlanQuotaDefaultItem(plan=plan.value, quotaKind=row.quotaKind.value, limit=row.limit)
            for row in rows
        ]
    )


class AdminUserRow(BaseModel):
    id: str
    name: str | None
    email: str | None
    plan: str
    role: str
    blocked: bool
    atOrOverLimit: bool
    createdAt: datetime


class AdminUsersListResponse(BaseModel):
    users: list[AdminUserRow]
    total: int
    page: int
    pageSize: int


_SORTABLE_COLUMNS = {
    "name": User.name,
    "email": User.email,
    "role": User.role,
    "blocked": User.blockedAt,
    "createdAt": User.createdAt,
}


def _row_of(user: User, plan: Plan, at_or_over_limit: bool) -> AdminUserRow:
    return AdminUserRow(
        id=user.id,
        name=user.name,
        email=user.email,
        plan=plan.value,
        role=user.role.value,
        blocked=user.blockedAt is not None,
        atOrOverLimit=at_or_over_limit,
        createdAt=user.createdAt,
    )


@router.get("/users", response_model=AdminUsersListResponse)
async def list_users(
    search: str | None = Query(None),
    plan: Plan | None = Query(None),
    role: Role | None = Query(None),
    blocked: bool | None = Query(None),
    at_or_over_limit: bool = Query(False, alias="atOrOverLimit"),
    sort_by: str = Query("createdAt", alias="sortBy"),
    sort_dir: str = Query("desc", alias="sortDir"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminUsersListResponse:
    """Rewritten for scale (issue #147): a lightweight row per User (Plan
    reassignment, quotas and overrides now live on the User panel instead),
    searchable by name/email, filterable by Plan/Role/blocked/
    atOrOverLimit, sortable, and paginated — search/filter/sort/pagination
    all applied server-side since the table is no longer expected to fit
    unpaginated in one response.

    `plan` now filters on Effective Plan (issue #155, docs/adr/0018,
    Subscription-derived) rather than the legacy `User.plan` column, and
    `atOrOverLimit` needs every candidate's Effective quota computed
    (`_user_quota_summary`) — neither is a SQL-filterable column, so when
    either is active every other filter is applied in SQL first, then the
    already-narrowed candidate set is filtered and paginated in Python.
    When neither filter is requested, pagination stays in SQL and Effective
    Plan/quotas are only computed for the one page of rows returned.
    """
    stmt = select(User)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(User.name.ilike(pattern), User.email.ilike(pattern)))
    if role is not None:
        stmt = stmt.where(User.role == role)
    if blocked is not None:
        stmt = stmt.where(User.blockedAt.isnot(None) if blocked else User.blockedAt.is_(None))

    sort_column = _SORTABLE_COLUMNS.get(sort_by, User.createdAt)
    stmt = stmt.order_by(sort_column.asc() if sort_dir == "asc" else sort_column.desc())

    if at_or_over_limit or plan is not None:
        candidates = (await session.scalars(stmt)).all()
        matching: list[AdminUserRow] = []
        for user in candidates:
            user_plan = await effective_plan(session, user.id)
            if plan is not None and user_plan != plan:
                continue
            _, over = await _user_quota_summary(session, user.id)
            if at_or_over_limit and not over:
                continue
            matching.append(_row_of(user, user_plan, over))
        total = len(matching)
        start = (page - 1) * page_size
        rows = matching[start : start + page_size]
    else:
        total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        page_stmt = stmt.offset((page - 1) * page_size).limit(page_size)
        candidates = (await session.scalars(page_stmt)).all()
        rows = []
        for user in candidates:
            user_plan = await effective_plan(session, user.id)
            _, over = await _user_quota_summary(session, user.id)
            rows.append(_row_of(user, user_plan, over))

    return AdminUsersListResponse(users=rows, total=total, page=page, pageSize=page_size)


class SignupSeriesPoint(BaseModel):
    date: str
    count: int


class AdminStatsResponse(BaseModel):
    totalUsers: int
    usersOverLimitCount: int
    analysesRequestedToday: int
    analysesRequestedThisMonth: int
    documentsCreatedToday: int
    activeScoutsTotal: int
    newSignups: list[SignupSeriesPoint]
    usersByPlan: dict[str, int]
    blockedUsersCount: int


_PERIOD_DAYS: dict[str, int | None] = {"7d": 7, "30d": 30, "90d": 90, "all": None}


def _signup_series(users: list[User], period: str) -> list[SignupSeriesPoint]:
    """Buckets `users` by signup date (day granularity) across `period`,
    restricted to the window that period names — `\"all\"` includes every
    signup date present. Only this figure reacts to `period`; every other
    stat below is a today-snapshot (issue #145).
    """
    days = _PERIOD_DAYS[period]
    cutoff = (_now() - timedelta(days=days)).date() if days is not None else None
    counts: dict[str, int] = {}
    for user in users:
        signup_date = user.createdAt.date()
        if cutoff is not None and signup_date < cutoff:
            continue
        key = signup_date.isoformat()
        counts[key] = counts.get(key, 0) + 1
    return [
        SignupSeriesPoint(date=date, count=count)
        for date, count in sorted(counts.items())
    ]


@router.get("/stats", response_model=AdminStatsResponse)
async def get_stats(
    period: Literal["7d", "30d", "90d", "all"] = Query(default="all"),
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminStatsResponse:
    """Global aggregate usage numbers across every User, for the Admin
    dashboard (issue #145, enriching issue #140's original 6 figures): total
    Analyses/GeneratedDocuments/active Scouts platform-wide, how many Users
    are currently at or over any of their own QuotaKind limits, a
    `period`-filtered new-signups series, and today-snapshots of the
    Effective Plan distribution and blocked-User count that always ignore
    `period`.
    """
    users = (await session.scalars(select(User))).all()
    users_over_limit = 0
    users_by_plan: dict[str, int] = {}
    blocked_users_count = 0
    for user in users:
        _, over = await _user_quota_summary(session, user.id)
        if over:
            users_over_limit += 1
        user_plan = await effective_plan(session, user.id)
        users_by_plan[user_plan.value] = users_by_plan.get(user_plan.value, 0) + 1
        if user.blockedAt is not None:
            blocked_users_count += 1

    return AdminStatsResponse(
        totalUsers=len(users),
        usersOverLimitCount=users_over_limit,
        analysesRequestedToday=await total_analyses_requested_today(session),
        analysesRequestedThisMonth=await total_analyses_requested_this_month(session),
        documentsCreatedToday=await total_generated_documents_created_today(session),
        activeScoutsTotal=await total_active_scout_count(session),
        newSignups=_signup_series(users, period),
        usersByPlan=users_by_plan,
        blockedUsersCount=blocked_users_count,
    )


class AdminCVVersionRow(BaseModel):
    id: str
    userId: str
    userName: str | None
    userEmail: str | None
    label: str
    fileName: str
    fileType: str
    isDefault: bool
    conversionStatus: str
    conversionError: str | None
    supersededById: str | None
    createdAt: datetime
    updatedAt: datetime


class AdminCVVersionsListResponse(BaseModel):
    cvVersions: list[AdminCVVersionRow]
    total: int
    page: int
    pageSize: int


@router.get("/cv-versions", response_model=AdminCVVersionsListResponse)
async def list_admin_cv_versions(
    user_id: str | None = Query(None, alias="userId"),
    created_at_from: datetime | None = Query(None, alias="createdAtFrom"),
    created_at_to: datetime | None = Query(None, alias="createdAtTo"),
    conversion_status: Cvconversionstatus | None = Query(None, alias="conversionStatus"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminCVVersionsListResponse:
    """Every candidate's CVVersion in one cross-user, filterable, paginated
    list (issue #163) -- filterable by `userId`, a `createdAt` range, and
    `conversionStatus`; sorted newest first, matching the candidate-facing
    `list_cv_versions` order. Superseded rows are included by default (no
    extra flag needed) since an Administrator troubleshooting a stuck or
    failed conversion needs full history, unlike the candidate-facing page.
    The owner's name/email are resolved here (mirroring `get_audit_events`'s
    actor resolution) so the frontend never has to do its own per-row lookup.
    """
    stmt = select(CVVersion)
    if user_id is not None:
        stmt = stmt.where(CVVersion.userId == user_id)
    if created_at_from is not None:
        stmt = stmt.where(CVVersion.createdAt >= created_at_from)
    if created_at_to is not None:
        stmt = stmt.where(CVVersion.createdAt <= created_at_to)
    if conversion_status is not None:
        stmt = stmt.where(CVVersion.conversionStatus == conversion_status)
    stmt = stmt.order_by(CVVersion.createdAt.desc())

    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    page_stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await session.scalars(page_stmt)).all()

    owner_ids = {row.userId for row in rows}
    owners: dict[str, User] = {}
    if owner_ids:
        owner_rows = (await session.scalars(select(User).where(User.id.in_(owner_ids)))).all()
        owners = {owner.id: owner for owner in owner_rows}

    return AdminCVVersionsListResponse(
        cvVersions=[
            AdminCVVersionRow(
                id=row.id,
                userId=row.userId,
                userName=owners[row.userId].name if row.userId in owners else None,
                userEmail=owners[row.userId].email if row.userId in owners else None,
                label=row.label,
                fileName=row.fileName,
                fileType=row.fileType.value,
                isDefault=row.isDefault,
                conversionStatus=row.conversionStatus.value,
                conversionError=row.conversionError,
                supersededById=row.supersededById,
                createdAt=row.createdAt,
                updatedAt=row.updatedAt,
            )
            for row in rows
        ],
        total=total,
        page=page,
        pageSize=page_size,
    )


class AdminReconvertCVVersionResponse(BaseModel):
    cvVersionId: str
    conversionStatus: str


@router.post(
    "/cv-versions/{cv_version_id}/reconvert",
    response_model=AdminReconvertCVVersionResponse,
    status_code=202,
)
async def reconvert_cv_version(
    cv_version_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminReconvertCVVersionResponse:
    """Admin-scoped reconvert trigger (issue #163) -- the only write action
    this table offers (no Set default/Import/Replace anywhere in the Admin
    area). Mirrors `v1.convert_cv_version`'s PENDING-reset-plus-enqueue
    exactly, except ownership is derived from the target CVVersion itself
    rather than a caller's own userId (docs/adr/0020: an admin action never
    changes who owns the resource, and no target-user override is accepted),
    and it records an AdminAuditEvent alongside the change instead of just
    mutating silently.
    """
    existing = await session.get(CVVersion, cv_version_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="CVVersion not found")

    if existing.conversionStatus == Cvconversionstatus.CONVERTING:
        raise HTTPException(status_code=409, detail="A Conversion is already running for this CV")

    existing.conversionStatus = Cvconversionstatus.PENDING
    existing.conversionError = None
    existing.updatedAt = _now()

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=existing.userId,
        resource_type="CVVersion",
        resource_id=existing.id,
    )
    await session.commit()

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=CV_CONVERSION_QUEUE_URL,
        MessageBody=json.dumps({"cvVersionId": cv_version_id}),
    )

    return AdminReconvertCVVersionResponse(
        cvVersionId=existing.id, conversionStatus=existing.conversionStatus.value
    )


class AdminAnalysisRow(BaseModel):
    id: str
    userId: str
    userName: str | None
    userEmail: str | None
    jobOfferId: str
    jobOfferTitle: str | None
    jobOfferCompany: str | None
    status: str
    applicationStatus: str | None
    requestedAt: datetime
    completedAt: datetime | None


class AdminAnalysesListResponse(BaseModel):
    analyses: list[AdminAnalysisRow]
    total: int
    page: int
    pageSize: int


@router.get("/analyses", response_model=AdminAnalysesListResponse)
async def list_admin_analyses(
    user_id: str | None = Query(None, alias="userId"),
    requested_at_from: datetime | None = Query(None, alias="requestedAtFrom"),
    requested_at_to: datetime | None = Query(None, alias="requestedAtTo"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminAnalysesListResponse:
    """Every candidate's Analysis in one cross-user, filterable, paginated
    list (issue #161) -- filterable by `userId` and a `requestedAt` range;
    no status filter, since Tracking status is read-only context here (the
    candidate's own `/analyses` page owns that transition, docs/adr/0019).
    Sorted newest first, matching the candidate-facing `list_analyses`
    order. The owner's name/email and the linked JobOffer's title/company
    are resolved here (mirroring `list_admin_cv_versions`) so the frontend
    never has to do its own per-row lookup, and `applicationStatus` is
    returned so the frontend can fold it into a Tracking-status badge the
    same way the candidate page's `trackingStatusOf` does.
    """
    stmt = select(Analysis)
    if user_id is not None:
        stmt = stmt.where(Analysis.userId == user_id)
    if requested_at_from is not None:
        stmt = stmt.where(Analysis.requestedAt >= requested_at_from)
    if requested_at_to is not None:
        stmt = stmt.where(Analysis.requestedAt <= requested_at_to)
    stmt = stmt.order_by(Analysis.requestedAt.desc())

    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    page_stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await session.scalars(page_stmt)).all()

    owner_ids = {row.userId for row in rows}
    owners: dict[str, User] = {}
    if owner_ids:
        owner_rows = (await session.scalars(select(User).where(User.id.in_(owner_ids)))).all()
        owners = {owner.id: owner for owner in owner_rows}

    job_offer_ids = {row.jobOfferId for row in rows}
    job_offers: dict[str, JobOffer] = {}
    if job_offer_ids:
        job_offer_rows = (
            await session.scalars(select(JobOffer).where(JobOffer.id.in_(job_offer_ids)))
        ).all()
        job_offers = {job_offer.id: job_offer for job_offer in job_offer_rows}

    analysis_ids = {row.id for row in rows}
    applications: dict[str, Application] = {}
    if analysis_ids:
        application_rows = (
            await session.scalars(
                select(Application).where(Application.analysisId.in_(analysis_ids))
            )
        ).all()
        applications = {application.analysisId: application for application in application_rows}

    return AdminAnalysesListResponse(
        analyses=[
            AdminAnalysisRow(
                id=row.id,
                userId=row.userId,
                userName=owners[row.userId].name if row.userId in owners else None,
                userEmail=owners[row.userId].email if row.userId in owners else None,
                jobOfferId=row.jobOfferId,
                jobOfferTitle=job_offers[row.jobOfferId].title
                if row.jobOfferId in job_offers
                else None,
                jobOfferCompany=job_offers[row.jobOfferId].company
                if row.jobOfferId in job_offers
                else None,
                status=row.status.value,
                applicationStatus=applications[row.id].status.value
                if row.id in applications
                else None,
                requestedAt=row.requestedAt,
                completedAt=row.completedAt,
            )
            for row in rows
        ],
        total=total,
        page=page,
        pageSize=page_size,
    )


class AdminRetryAnalysisResponse(BaseModel):
    analysisId: str
    status: str


@router.post(
    "/analyses/{analysis_id}/retry",
    response_model=AdminRetryAnalysisResponse,
    status_code=202,
)
async def retry_analysis(
    analysis_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminRetryAnalysisResponse:
    """Admin-scoped "Relancer l'analyse" (issue #161) -- creates a brand-new
    Analysis owned by the original candidate rather than mutating the
    target row in place, mirroring how the candidate's own `POST
    /v1/analyses` always creates a new row too. Ownership is derived from
    the target Analysis itself, never from the admin caller (docs/adr/0020),
    and no quota check applies -- an admin-triggered recovery action isn't
    counted against the candidate's own daily/monthly analysis budget, the
    same way `reconvert_cv_version` applies no quota either.
    """
    existing = await session.get(Analysis, analysis_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Analysis not found")

    new_analysis = Analysis(
        id=str(uuid.uuid4()),
        userId=existing.userId,
        jobOfferId=existing.jobOfferId,
        cvVersionId=existing.cvVersionId,
        status=Analysisstatus.PENDING,
    )
    session.add(new_analysis)

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=existing.userId,
        resource_type="Analysis",
        resource_id=new_analysis.id,
    )
    await session.commit()

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=ANALYSIS_INTAKE_QUEUE_URL,
        MessageBody=json.dumps({"analysisId": new_analysis.id}),
    )

    return AdminRetryAnalysisResponse(analysisId=new_analysis.id, status=new_analysis.status.value)


class AdminGeneratedDocumentSummary(BaseModel):
    id: str
    type: str
    status: str


class AdminGenerateDocumentsResponse(BaseModel):
    generatedDocuments: list[AdminGeneratedDocumentSummary]


@router.post(
    "/analyses/{analysis_id}/generated-documents",
    response_model=AdminGenerateDocumentsResponse,
    status_code=202,
)
async def admin_create_generated_documents(
    analysis_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminGenerateDocumentsResponse:
    """Admin-scoped "Générer les documents" (issue #161) -- mirrors
    `v1.create_generated_documents` exactly (COVER_LETTER + TAILORED_CV,
    PENDING, lazily creating the owning Application), except ownership is
    derived from the target Analysis itself rather than a caller's own
    userId (docs/adr/0020), no quota check applies (same rationale as
    `retry_analysis` above), and it records one AdminAuditEvent referencing
    the Analysis instead of mutating silently.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise HTTPException(status_code=404, detail="Analysis not found")
    if analysis.status != Analysisstatus.COMPLETED:
        raise HTTPException(
            status_code=400,
            detail="Analysis must be COMPLETED before generating documents",
        )

    existing_application = await session.scalar(
        select(Application).where(Application.analysisId == analysis.id)
    )
    if existing_application is None:
        session.add(
            Application(
                id=str(uuid.uuid4()),
                userId=analysis.userId,
                analysisId=analysis.id,
                jobOfferId=analysis.jobOfferId,
                cvVersionId=analysis.cvVersionId,
                scoutId=analysis.scoutId,
                status=Applicationstatus.DRAFT,
                updatedAt=_now(),
            )
        )

    scout_run_id: str | None = None
    if analysis.ingestionJobId:
        ingestion_job = await session.get(IngestionJob, analysis.ingestionJobId)
        if ingestion_job is not None:
            scout_run_id = ingestion_job.scoutRunId

    now = _now()
    documents = [
        GeneratedDocument(
            id=str(uuid.uuid4()),
            type=doc_type,
            analysisId=analysis.id,
            jobOfferId=analysis.jobOfferId,
            cvVersionId=analysis.cvVersionId,
            scoutRunId=scout_run_id,
            status=Generateddocumentstatus.PENDING,
            updatedAt=now,
        )
        for doc_type in (Generateddocumenttype.COVER_LETTER, Generateddocumenttype.TAILORED_CV)
    ]
    session.add_all(documents)

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=analysis.userId,
        resource_type="Analysis",
        resource_id=analysis.id,
    )
    await session.commit()

    sqs = make_sqs_client()
    for document in documents:
        sqs.send_message(
            QueueUrl=GENERATION_INTAKE_QUEUE_URL,
            MessageBody=json.dumps({"generatedDocumentId": document.id}),
        )

    return AdminGenerateDocumentsResponse(
        generatedDocuments=[
            AdminGeneratedDocumentSummary(id=doc.id, type=doc.type.value, status=doc.status.value)
            for doc in documents
        ]
    )


class AdminScoutRow(BaseModel):
    id: str
    userId: str
    userName: str | None
    userEmail: str | None
    label: str
    status: str
    matchThreshold: int
    lastRunAt: datetime | None
    createdAt: datetime
    updatedAt: datetime


class AdminScoutsListResponse(BaseModel):
    scouts: list[AdminScoutRow]
    total: int
    page: int
    pageSize: int


@router.get("/scouts", response_model=AdminScoutsListResponse)
async def list_admin_scouts(
    user_id: str | None = Query(None, alias="userId"),
    last_run_at_from: datetime | None = Query(None, alias="lastRunAtFrom"),
    last_run_at_to: datetime | None = Query(None, alias="lastRunAtTo"),
    status: Scoutstatus | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminScoutsListResponse:
    """Every candidate's Scout in one cross-user, filterable, paginated list
    (issue #162) -- filterable by `userId`, a `lastRunAt` range, and
    `status`. Sorted newest-created first, matching every other Admin table
    in this file. The owner's name/email are resolved here the same way
    `list_admin_cv_versions`/`list_admin_analyses` do, so the frontend never
    does its own per-row lookup.
    """
    stmt = select(Scout)
    if user_id is not None:
        stmt = stmt.where(Scout.userId == user_id)
    if last_run_at_from is not None:
        stmt = stmt.where(Scout.lastRunAt >= last_run_at_from)
    if last_run_at_to is not None:
        stmt = stmt.where(Scout.lastRunAt <= last_run_at_to)
    if status is not None:
        stmt = stmt.where(Scout.status == status)
    stmt = stmt.order_by(Scout.createdAt.desc())

    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    page_stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await session.scalars(page_stmt)).all()

    owner_ids = {row.userId for row in rows}
    owners: dict[str, User] = {}
    if owner_ids:
        owner_rows = (await session.scalars(select(User).where(User.id.in_(owner_ids)))).all()
        owners = {owner.id: owner for owner in owner_rows}

    return AdminScoutsListResponse(
        scouts=[
            AdminScoutRow(
                id=row.id,
                userId=row.userId,
                userName=owners[row.userId].name if row.userId in owners else None,
                userEmail=owners[row.userId].email if row.userId in owners else None,
                label=row.label,
                status=row.status.value,
                matchThreshold=row.matchThreshold,
                lastRunAt=row.lastRunAt,
                createdAt=row.createdAt,
                updatedAt=row.updatedAt,
            )
            for row in rows
        ],
        total=total,
        page=page,
        pageSize=page_size,
    )


class AdminScoutActionResponse(BaseModel):
    scoutId: str
    status: str


@router.post(
    "/scouts/{scout_id}/pause",
    response_model=AdminScoutActionResponse,
)
async def pause_scout(
    scout_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminScoutActionResponse:
    """Admin-scoped pause (issue #162) -- mirrors `v1.update_scout`'s status
    write for a Scout that's still read/write (an ARCHIVED Scout stays
    read-only there too), except ownership is derived from the target Scout
    itself, never a caller override (docs/adr/0020), and it records an
    AdminAuditEvent instead of mutating silently.
    """
    scout = await session.get(Scout, scout_id)
    if scout is None:
        raise HTTPException(status_code=404, detail="Scout not found")
    if scout.status == Scoutstatus.ARCHIVED:
        raise HTTPException(status_code=409, detail="Archived Scouts are read-only")

    scout.status = Scoutstatus.PAUSED
    scout.updatedAt = _now()

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=scout.userId,
        resource_type="Scout",
        resource_id=scout.id,
    )
    await session.commit()

    return AdminScoutActionResponse(scoutId=scout.id, status=scout.status.value)


@router.post(
    "/scouts/{scout_id}/resume",
    response_model=AdminScoutActionResponse,
)
async def resume_scout(
    scout_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminScoutActionResponse:
    """Admin-scoped resume (issue #162) -- the mirror of `pause_scout` above.
    An ARCHIVED Scout stays read-only from this surface: there is no
    admin-facing unarchive/resume-from-archived (only the candidate's own
    Edit on `/scouts` can do that). Unlike `v1.update_scout`'s own
    PAUSED->ACTIVE transition, no ACTIVE_SCOUTS quota check applies here --
    same rationale as `retry_analysis`/`admin_create_generated_documents`:
    an admin-triggered action isn't counted against the candidate's own
    budget.
    """
    scout = await session.get(Scout, scout_id)
    if scout is None:
        raise HTTPException(status_code=404, detail="Scout not found")
    if scout.status == Scoutstatus.ARCHIVED:
        raise HTTPException(status_code=409, detail="Archived Scouts are read-only")

    scout.status = Scoutstatus.ACTIVE
    scout.updatedAt = _now()

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=scout.userId,
        resource_type="Scout",
        resource_id=scout.id,
    )
    await session.commit()

    return AdminScoutActionResponse(scoutId=scout.id, status=scout.status.value)


@router.post(
    "/scouts/{scout_id}/archive",
    response_model=AdminScoutActionResponse,
)
async def archive_scout(
    scout_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminScoutActionResponse:
    """Admin-scoped archive (issue #162) -- deliberately one-directional:
    this file offers no unarchive counterpart, so once a Scout lands here it
    can only become read/write again via the candidate's own Edit on their
    own `/scouts` page. Idempotent for an already-ARCHIVED Scout (no error),
    since re-archiving changes nothing.
    """
    scout = await session.get(Scout, scout_id)
    if scout is None:
        raise HTTPException(status_code=404, detail="Scout not found")

    scout.status = Scoutstatus.ARCHIVED
    scout.updatedAt = _now()

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=scout.userId,
        resource_type="Scout",
        resource_id=scout.id,
    )
    await session.commit()

    return AdminScoutActionResponse(scoutId=scout.id, status=scout.status.value)


class AdminRunScoutResponse(BaseModel):
    scoutId: str
    scoutRunId: str
    status: str


@router.post(
    "/scouts/{scout_id}/run",
    response_model=AdminRunScoutResponse,
    status_code=201,
)
async def admin_run_scout(
    scout_id: str,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminRunScoutResponse:
    """Admin-scoped "Run now" (issue #162) -- mirrors `v1.run_scout` exactly
    (same ARCHIVED guard, same one-run-per-hour throttle, since an
    admin-triggered run still hits the same scraped sites a candidate's own
    run would), except ownership is derived from the target Scout itself
    (docs/adr/0020) and it records an AdminAuditEvent instead of mutating
    silently.
    """
    scout = await session.get(Scout, scout_id)
    if scout is None:
        raise HTTPException(status_code=404, detail="Scout not found")
    if scout.status == Scoutstatus.ARCHIVED:
        raise HTTPException(status_code=409, detail="Archived Scouts cannot be run")

    latest = await session.scalar(
        select(ScoutRun)
        .where(ScoutRun.scoutId == scout.id)
        .order_by(ScoutRun.createdAt.desc())
        .limit(1)
    )
    if latest is not None and latest.createdAt > _now() - _scout_run_rate_limit():
        raise HTTPException(
            status_code=429,
            detail="This Scout ran within the last hour. Try again later.",
        )

    scout_run = ScoutRun(
        id=str(uuid.uuid4()),
        scoutId=scout.id,
        status=Scoutrunstatus.PENDING,
    )
    session.add(scout_run)

    record_admin_audit_event(
        session,
        actor_user_id=admin_id,
        target_user_id=scout.userId,
        resource_type="Scout",
        resource_id=scout.id,
    )
    await session.commit()
    await session.refresh(scout_run)

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=SCOUT_INTAKE_QUEUE_URL,
        MessageBody=json.dumps({"scoutRunId": scout_run.id}),
    )

    return AdminRunScoutResponse(
        scoutId=scout.id, scoutRunId=scout_run.id, status=scout_run.status.value
    )
