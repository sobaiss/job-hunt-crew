import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from py_db.models import Plan, PlanQuotaDefault, Quotakind, QuotaOverride, User
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
    effective_quota,
    record_admin_audit_event,
    total_active_scout_count,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session

router = APIRouter(prefix="/v1/admin")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def require_admin(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_is_admin: str | None = Header(default=None, alias="X-User-Is-Admin"),
) -> str:
    """Rejects any caller whose forwarded `isAdmin` flag isn't set (issue
    #138, decoupled from Plan in #144 per docs/adr/0015). Trusts the
    BFF-forwarded X-User-Is-Admin header the same way `require_user_id`
    trusts X-User-Id — no independent re-verification against Postgres, same
    MVP boundary as the Internal API secret.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    if x_user_is_admin != "true":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return x_user_id


class AdminMeResponse(BaseModel):
    userId: str
    plan: str
    isAdmin: bool


@router.get("/me", response_model=AdminMeResponse)
async def admin_me(
    user_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminMeResponse:
    """Backs the bare `/admin` landing page (issue #138) — confirms the
    caller actually cleared `require_admin`, and reports their real Plan
    now that admin access no longer implies one (#144).
    """
    target = await _get_target_user(session, user_id)
    return AdminMeResponse(userId=target.id, plan=target.plan.value, isAdmin=target.isAdmin)


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
    plan: str
    quotas: dict[str, QuotaUsage]


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
    """A target User's Plan, Effective quota, current usage, and which
    QuotaKinds carry an explicit `QuotaOverride`, for the admin per-user
    detail screen (issue #139).
    """
    target = await _get_target_user(session, user_id)
    quotas, _ = await _user_quota_summary(session, user_id)
    return UserQuotasResponse(userId=target.id, plan=target.plan.value, quotas=quotas)


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


class SetPlanResponse(BaseModel):
    userId: str
    plan: str


@router.put("/users/{user_id}/plan", response_model=SetPlanResponse)
async def set_user_plan(
    user_id: str,
    req: SetPlanRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> SetPlanResponse:
    """Reassigns `user_id`'s Plan (issue #139). A no-op request (the same
    Plan the User already has) writes no `AdminAuditEvent` — only an actual
    change is audited, matching `delete_quota_override`'s idempotency.
    """
    target = await _get_target_user(session, user_id)

    if req.plan != target.plan:
        old_plan = target.plan.value
        target.plan = req.plan
        target.updatedAt = _now()
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=user_id,
            field="plan",
            old_value=old_plan,
            new_value=req.plan.value,
        )
        await session.commit()

    return SetPlanResponse(userId=target.id, plan=target.plan.value)


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


class SetPlanQuotaDefaultRequest(BaseModel):
    limit: int | None = None


@router.put("/plan-defaults/{plan}/{kind}", response_model=PlanQuotaDefaultItem)
async def set_plan_default(
    plan: Plan,
    kind: Quotakind,
    req: SetPlanQuotaDefaultRequest,
    admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> PlanQuotaDefaultItem:
    """Edits `plan`'s default ceiling for `kind` (issue #140). Reaches every
    User on `plan` with no `QuotaOverride` for `kind` on their very next
    `effective_quota` read — no backfill needed, since that resolution always
    reads this row live (docs/adr/0013). A no-op request (the same limit
    already set) writes no `AdminAuditEvent`, matching `set_user_plan`'s
    idempotency.
    """
    row = await session.scalar(
        select(PlanQuotaDefault).where(
            PlanQuotaDefault.plan == plan, PlanQuotaDefault.quotaKind == kind
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="PlanQuotaDefault not found")

    if row.limit != req.limit:
        old_value = "null" if row.limit is None else str(row.limit)
        row.limit = req.limit
        row.updatedAt = _now()
        record_admin_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=None,
            field=f"planQuotaDefault:{plan.value}:{kind.value}",
            old_value=old_value,
            new_value="null" if req.limit is None else str(req.limit),
        )
        await session.commit()

    return PlanQuotaDefaultItem(plan=plan.value, quotaKind=kind.value, limit=row.limit)


class AdminUserSummary(BaseModel):
    userId: str
    email: str | None
    plan: str
    quotas: dict[str, QuotaUsage]
    atOrOverLimit: bool


class AdminUsersResponse(BaseModel):
    users: list[AdminUserSummary]


@router.get("/users", response_model=AdminUsersResponse)
async def list_users(
    at_or_over_limit: bool = Query(False, alias="atOrOverLimit"),
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminUsersResponse:
    """Every User's Plan and usage summary per QuotaKind, filterable to those
    currently at or over any limit, for the admin reporting screen (issue
    #140).
    """
    users = (await session.scalars(select(User))).all()

    summaries: list[AdminUserSummary] = []
    for user in users:
        quotas, over = await _user_quota_summary(session, user.id)
        if at_or_over_limit and not over:
            continue
        summaries.append(
            AdminUserSummary(
                userId=user.id,
                email=user.email,
                plan=user.plan.value,
                quotas=quotas,
                atOrOverLimit=over,
            )
        )

    return AdminUsersResponse(users=summaries)


class AdminStatsResponse(BaseModel):
    totalUsers: int
    usersOverLimitCount: int
    analysesRequestedToday: int
    analysesRequestedThisMonth: int
    documentsCreatedToday: int
    activeScoutsTotal: int


@router.get("/stats", response_model=AdminStatsResponse)
async def get_stats(
    _admin_id: str = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> AdminStatsResponse:
    """Global aggregate usage numbers across every User, for the admin
    reporting screen (issue #140): total Analyses/GeneratedDocuments/active
    Scouts platform-wide, and how many Users are currently at or over any of
    their own QuotaKind limits.
    """
    users = (await session.scalars(select(User))).all()
    users_over_limit = 0
    for user in users:
        _, over = await _user_quota_summary(session, user.id)
        if over:
            users_over_limit += 1

    return AdminStatsResponse(
        totalUsers=len(users),
        usersOverLimitCount=users_over_limit,
        analysesRequestedToday=await total_analyses_requested_today(session),
        analysesRequestedThisMonth=await total_analyses_requested_this_month(session),
        documentsCreatedToday=await total_generated_documents_created_today(session),
        activeScoutsTotal=await total_active_scout_count(session),
    )
