import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from py_db.models import Plan, Quotakind, QuotaOverride, User
from py_db.quota import (
    analyses_requested_this_month,
    analyses_requested_today,
    generated_documents_created_today,
)
from py_db.quotas import active_scout_count, effective_quota, record_quota_audit_event
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session

router = APIRouter(prefix="/v1/admin")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def require_admin(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_plan: str | None = Header(default=None, alias="X-User-Plan"),
) -> str:
    """Rejects any caller whose forwarded Plan isn't ADMINISTRATEUR (issue
    #138). Trusts the BFF-forwarded X-User-Plan header the same way
    `require_user_id` trusts X-User-Id — no independent re-verification
    against Postgres, same MVP boundary as the Internal API secret.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    if x_user_plan != Plan.ADMINISTRATEUR.value:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return x_user_id


class AdminMeResponse(BaseModel):
    userId: str
    plan: str


@router.get("/me", response_model=AdminMeResponse)
async def admin_me(user_id: str = Depends(require_admin)) -> AdminMeResponse:
    """Backs the bare `/admin` landing page (issue #138) — confirms the
    caller actually cleared `require_admin`. #139/#140 add the real
    per-user and reporting endpoints behind this same dependency.
    """
    return AdminMeResponse(userId=user_id, plan=Plan.ADMINISTRATEUR.value)


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

    override_kinds = set(
        (
            await session.scalars(
                select(QuotaOverride.quotaKind).where(QuotaOverride.userId == user_id)
            )
        ).all()
    )

    quotas: dict[str, QuotaUsage] = {}
    for kind in Quotakind:
        cap = await effective_quota(session, user_id, kind)
        used = await _usage_for(session, user_id, kind)
        quotas[kind.value] = QuotaUsage(
            cap=cap,
            used=used,
            remaining=None if cap is None else max(cap - used, 0),
            hasOverride=kind in override_kinds,
        )

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
    User specifically (issue #139). Writes one `QuotaAuditEvent` in the same
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

    record_quota_audit_event(
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
    record_quota_audit_event(
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
    Plan the User already has) writes no `QuotaAuditEvent` — only an actual
    change is audited, matching `delete_quota_override`'s idempotency.
    """
    target = await _get_target_user(session, user_id)

    if req.plan != target.plan:
        old_plan = target.plan.value
        target.plan = req.plan
        target.updatedAt = _now()
        record_quota_audit_event(
            session,
            actor_user_id=admin_id,
            target_user_id=user_id,
            field="plan",
            old_value=old_plan,
            new_value=req.plan.value,
        )
        await session.commit()

    return SetPlanResponse(userId=target.id, plan=target.plan.value)
