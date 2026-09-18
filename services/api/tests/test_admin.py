import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    AdminAuditEvent,
    Duration,
    Plan,
    PlanQuotaDefault,
    Quotakind,
    QuotaOverride,
    Subscription,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select, update

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}
ADMIN_HEADERS = {**HEADERS, "X-User-Is-Admin": "true"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


async def _create_user(
    plan: Plan = Plan.FREE,
    is_admin: bool = False,
    name: str | None = None,
    email: str | None = None,
    blocked: bool = False,
    created_at: datetime | None = None,
) -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            user = User(
                id=user_id,
                name=name,
                email=email or f"{user_id}@example.com",
                plan=plan,
                isAdmin=is_admin,
                blockedAt=datetime.now(UTC).replace(tzinfo=None) if blocked else None,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
            if created_at is not None:
                user.createdAt = created_at
            session.add(user)
            await session.commit()
    finally:
        await engine.dispose()
    return user_id


async def _delete_user(user_id: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _give_active_subscription(
    user_id: str,
    plan: Plan,
    *,
    duration: Duration | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
) -> None:
    """Directly seeds a Subscription for `user_id` (issue #153/docs/adr/0018)
    -- effective_quota now derives Effective Plan from Subscription, not the
    legacy `PUT .../plan` endpoint's User.plan write. Defaults to an
    unbounded, currently-active row; `duration`/`end_date` let #155's tests
    seed a dated one directly, without going through the endpoint under test.
    """
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                Subscription(
                    id=str(uuid.uuid4()),
                    userId=user_id,
                    plan=plan,
                    startDate=start_date or datetime.now(UTC).replace(tzinfo=None),
                    duration=duration,
                    endDate=end_date,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


@pytest.fixture
def admin_id():
    uid = asyncio.run(_create_user(is_admin=True))
    yield uid
    asyncio.run(_delete_user(uid))


@pytest.fixture
def target_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


def _admin_headers(admin_id: str) -> dict[str, str]:
    return {**ADMIN_HEADERS, "X-User-Id": admin_id}


async def _free_plan_default(kind: Quotakind) -> int | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(
                select(PlanQuotaDefault.limit).where(
                    PlanQuotaDefault.plan == Plan.FREE, PlanQuotaDefault.quotaKind == kind
                )
            )
    finally:
        await engine.dispose()


async def _set_free_plan_default(kind: Quotakind, limit: int | None) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(
                update(PlanQuotaDefault)
                .where(PlanQuotaDefault.plan == Plan.FREE, PlanQuotaDefault.quotaKind == kind)
                .values(limit=limit)
            )
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def analyses_daily_cap():
    original = asyncio.run(_free_plan_default(Quotakind.ANALYSES_DAILY))

    def _apply(limit: int | None) -> None:
        asyncio.run(_set_free_plan_default(Quotakind.ANALYSES_DAILY, limit))

    yield _apply
    asyncio.run(_set_free_plan_default(Quotakind.ANALYSES_DAILY, original))


async def _quota_override(user_id: str, kind: Quotakind) -> QuotaOverride | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(
                select(QuotaOverride).where(
                    QuotaOverride.userId == user_id, QuotaOverride.quotaKind == kind
                )
            )
    finally:
        await engine.dispose()


async def _audit_events(target_user_id: str) -> list[AdminAuditEvent]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            rows = await session.scalars(
                select(AdminAuditEvent).where(AdminAuditEvent.targetUserId == target_user_id)
            )
            return list(rows.all())
    finally:
        await engine.dispose()


async def _plan_default(plan: Plan, kind: Quotakind) -> int | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(
                select(PlanQuotaDefault.limit).where(
                    PlanQuotaDefault.plan == plan, PlanQuotaDefault.quotaKind == kind
                )
            )
    finally:
        await engine.dispose()


async def _set_plan_default(plan: Plan, kind: Quotakind, limit: int | None) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(
                update(PlanQuotaDefault)
                .where(PlanQuotaDefault.plan == plan, PlanQuotaDefault.quotaKind == kind)
                .values(limit=limit)
            )
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def standard_documents_daily_cap():
    original = asyncio.run(_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY))

    def _apply(limit: int | None) -> None:
        asyncio.run(_set_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY, limit))

    yield _apply
    asyncio.run(_set_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY, original))


async def _audit_events_for_field(field: str) -> list[AdminAuditEvent]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            rows = await session.scalars(
                select(AdminAuditEvent).where(AdminAuditEvent.field == field)
            )
            return list(rows.all())
    finally:
        await engine.dispose()


async def _subscriptions_for(user_id: str) -> list[Subscription]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            rows = await session.scalars(
                select(Subscription)
                .where(Subscription.userId == user_id)
                .order_by(Subscription.startDate.asc())
            )
            return list(rows.all())
    finally:
        await engine.dispose()


async def _user_blocked(user_id: str) -> bool:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            blocked_at = await session.scalar(select(User.blockedAt).where(User.id == user_id))
            return blocked_at is not None
    finally:
        await engine.dispose()


async def _user_email(user_id: str) -> str | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(select(User.email).where(User.id == user_id))
    finally:
        await engine.dispose()


async def _user_is_admin(user_id: str) -> bool:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return bool(await session.scalar(select(User.isAdmin).where(User.id == user_id)))
    finally:
        await engine.dispose()


def test_admin_route_rejects_caller_with_no_is_admin_header(user_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Id": user_id},
        )
    assert response.status_code == 403


def test_admin_route_rejects_non_admin_caller(user_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Id": user_id, "X-User-Is-Admin": "false"},
        )
    assert response.status_code == 403


def test_admin_route_rejects_missing_user_id():
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Is-Admin": "true"},
        )
    assert response.status_code == 401


def test_admin_route_allows_admin_caller(admin_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    assert response.json() == {"userId": admin_id, "plan": "FREE", "isAdmin": True}


# --- GET /v1/admin/users/{id}/quotas (issue #139) ---


def test_get_user_quotas_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.get(
            f"/v1/admin/users/{target_id}/quotas",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
        )
    assert response.status_code == 403


def test_get_user_quotas_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.get(
            f"/v1/admin/users/{uuid.uuid4()}/quotas",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_get_user_quotas_reports_plan_defaults_with_no_override(
    admin_id, target_id, analyses_daily_cap
):
    analyses_daily_cap(3)
    with TestClient(app) as client:
        response = client.get(
            f"/v1/admin/users/{target_id}/quotas",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    body = response.json()
    assert body["userId"] == target_id
    assert body["plan"] == "FREE"
    assert body["quotas"]["ANALYSES_DAILY"] == {
        "cap": 3,
        "used": 0,
        "remaining": 3,
        "hasOverride": False,
    }


def test_get_user_quotas_includes_target_users_info(admin_id):
    named_id = asyncio.run(_create_user(name="Grace Hopper", email="grace@example.com"))
    try:
        with TestClient(app) as client:
            response = client.get(
                f"/v1/admin/users/{named_id}/quotas",
                headers=_admin_headers(admin_id),
            )
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "Grace Hopper"
        assert body["email"] == "grace@example.com"
        assert body["isAdmin"] is False
        assert body["blocked"] is False
        assert "createdAt" in body
    finally:
        asyncio.run(_delete_user(named_id))


def test_get_user_quotas_flags_active_overrides(admin_id, target_id, analyses_daily_cap):
    analyses_daily_cap(3)
    with TestClient(app) as client:
        put_response = client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 10},
        )
        assert put_response.status_code == 200

        response = client.get(
            f"/v1/admin/users/{target_id}/quotas",
            headers=_admin_headers(admin_id),
        )
    body = response.json()
    assert body["quotas"]["ANALYSES_DAILY"] == {
        "cap": 10,
        "used": 0,
        "remaining": 10,
        "hasOverride": True,
    }


# --- PUT/DELETE /v1/admin/users/{id}/quota-overrides/{kind} (issue #139) ---


def test_set_quota_override_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"limit": 10},
        )
    assert response.status_code == 403


def test_set_quota_override_creates_row_and_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 25},
        )
    assert response.status_code == 200
    assert response.json() == {"quotaKind": "ANALYSES_DAILY", "limit": 25}

    override = asyncio.run(_quota_override(target_id, Quotakind.ANALYSES_DAILY))
    assert override is not None
    assert override.limit == 25

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].field == "quotaOverride:ANALYSES_DAILY"
    assert events[0].oldValue is None
    assert events[0].newValue == "25"


def test_set_quota_override_to_null_means_unlimited(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": None},
        )
    assert response.status_code == 200
    assert response.json() == {"quotaKind": "ANALYSES_DAILY", "limit": None}

    override = asyncio.run(_quota_override(target_id, Quotakind.ANALYSES_DAILY))
    assert override is not None
    assert override.limit is None

    events = asyncio.run(_audit_events(target_id))
    assert events[-1].newValue == "null"


def test_set_quota_override_updates_existing_row_and_records_old_value(admin_id, target_id):
    with TestClient(app) as client:
        client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 10},
        )
        response = client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 20},
        )
    assert response.status_code == 200

    override = asyncio.run(_quota_override(target_id, Quotakind.ANALYSES_DAILY))
    assert override.limit == 20

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 2
    assert events[1].oldValue == "10"
    assert events[1].newValue == "20"


def test_delete_quota_override_clears_row_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        client.put(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 10},
        )
        response = client.delete(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 204

    override = asyncio.run(_quota_override(target_id, Quotakind.ANALYSES_DAILY))
    assert override is None

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 2
    assert events[1].oldValue == "10"
    assert events[1].newValue is None


def test_delete_quota_override_is_idempotent_when_none_exists(admin_id, target_id):
    with TestClient(app) as client:
        response = client.delete(
            f"/v1/admin/users/{target_id}/quota-overrides/ANALYSES_DAILY",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 204
    assert asyncio.run(_audit_events(target_id)) == []


# --- PUT /v1/admin/users/{id}/plan (issue #139, rewritten for Subscriptions
# in #155/docs/adr/0018) ---


def test_set_plan_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"plan": "PREMIUM", "duration": "YEARLY"},
        )
    assert response.status_code == 403


def test_set_plan_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{uuid.uuid4()}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "PREMIUM", "duration": "YEARLY"},
        )
    assert response.status_code == 404


def test_set_plan_requires_duration_for_standard_and_premium(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "STANDARD"},
        )
    assert response.status_code == 400
    assert asyncio.run(_subscriptions_for(target_id)) == []


def test_set_plan_rejects_duration_for_free(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "FREE", "duration": "MONTHLY"},
        )
    assert response.status_code == 400
    assert asyncio.run(_subscriptions_for(target_id)) == []


def test_set_plan_assigns_standard_with_duration_and_computed_end_date(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "STANDARD", "duration": "MONTHLY"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["userId"] == target_id
    assert body["plan"] == "STANDARD"
    assert body["endDate"] is not None

    subscriptions = asyncio.run(_subscriptions_for(target_id))
    assert len(subscriptions) == 1
    assert subscriptions[0].plan == Plan.STANDARD
    assert subscriptions[0].duration == Duration.MONTHLY
    assert subscriptions[0].endDate is not None
    expected_end = subscriptions[0].startDate + timedelta(days=30)
    assert abs((subscriptions[0].endDate - expected_end).total_seconds()) < 5

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].field == "plan"
    assert events[0].oldValue == "FREE"
    assert events[0].newValue == "STANDARD:MONTHLY"


def test_set_plan_assigns_free_with_null_end_date_and_ends_current_subscription(
    admin_id, target_id
):
    asyncio.run(
        _give_active_subscription(
            target_id,
            Plan.PREMIUM,
            duration=Duration.YEARLY,
            end_date=datetime.now(UTC).replace(tzinfo=None) + timedelta(days=300),
        )
    )

    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "FREE"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["plan"] == "FREE"
    assert body["endDate"] is None

    subscriptions = asyncio.run(_subscriptions_for(target_id))
    assert len(subscriptions) == 2
    old, new = subscriptions
    assert old.plan == Plan.PREMIUM
    assert old.endDate is not None and old.endDate <= datetime.now(UTC).replace(tzinfo=None)
    assert new.plan == Plan.FREE
    assert new.duration is None
    assert new.endDate is None

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].oldValue == "PREMIUM:YEARLY"
    assert events[0].newValue == "FREE"


def test_set_plan_is_a_noop_when_plan_and_duration_unchanged_and_writes_no_audit_event(
    admin_id, target_id
):
    asyncio.run(_give_active_subscription(target_id, Plan.STANDARD, duration=Duration.MONTHLY))

    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "STANDARD", "duration": "MONTHLY"},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events(target_id)) == []
    assert len(asyncio.run(_subscriptions_for(target_id))) == 1


def test_set_plan_renews_by_creating_a_new_subscription_once_the_current_one_has_lapsed(
    admin_id, target_id
):
    now = datetime.now(UTC).replace(tzinfo=None)
    asyncio.run(
        _give_active_subscription(
            target_id,
            Plan.STANDARD,
            duration=Duration.MONTHLY,
            start_date=now - timedelta(days=40),
            end_date=now - timedelta(days=10),
        )
    )

    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "STANDARD", "duration": "MONTHLY"},
        )
    assert response.status_code == 200
    assert len(asyncio.run(_subscriptions_for(target_id))) == 2

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].oldValue == "FREE"
    assert events[0].newValue == "STANDARD:MONTHLY"


# --- PUT /v1/admin/users/{id}/blocked (issue #148) ---


def test_set_blocked_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/blocked",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"blocked": True},
        )
    assert response.status_code == 403


def test_set_blocked_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{uuid.uuid4()}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": True},
        )
    assert response.status_code == 404


def test_set_blocked_rejects_self_block(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{admin_id}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": True},
        )
    assert response.status_code == 400
    assert asyncio.run(_user_blocked(admin_id)) is False


def test_set_blocked_blocks_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": True},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": target_id, "blocked": True}
    assert asyncio.run(_user_blocked(target_id)) is True

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].field == "blockedAt"
    assert events[0].oldValue == "null"
    assert events[0].newValue is not None and events[0].newValue != "null"


def test_set_blocked_unblocks_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        first = client.put(
            f"/v1/admin/users/{target_id}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": True},
        )
        assert first.status_code == 200

        response = client.put(
            f"/v1/admin/users/{target_id}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": False},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": target_id, "blocked": False}
    assert asyncio.run(_user_blocked(target_id)) is False

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 2
    assert events[1].oldValue is not None and events[1].oldValue != "null"
    assert events[1].newValue == "null"


def test_set_blocked_is_a_noop_when_unchanged_and_writes_no_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": False},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events(target_id)) == []


# --- PUT /v1/admin/users/{id}/info (issue #149) ---


def test_set_info_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/info",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"name": "New Name"},
        )
    assert response.status_code == 403


def test_set_info_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{uuid.uuid4()}/info",
            headers=_admin_headers(admin_id),
            json={"name": "New Name"},
        )
    assert response.status_code == 404


def test_set_info_updates_name_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/info",
            headers=_admin_headers(admin_id),
            json={"name": "Ada Lovelace"},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": target_id, "name": "Ada Lovelace"}

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].field == "name"
    assert events[0].oldValue == "null"
    assert events[0].newValue == "Ada Lovelace"


def test_set_info_never_updates_email(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/info",
            headers=_admin_headers(admin_id),
            json={"name": "Ada Lovelace", "email": "hacked@example.com"},
        )
    assert response.status_code == 200
    assert "email" not in response.json()
    assert asyncio.run(_user_email(target_id)) != "hacked@example.com"


def test_set_info_is_a_noop_when_unchanged_and_writes_no_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        first = client.put(
            f"/v1/admin/users/{target_id}/info",
            headers=_admin_headers(admin_id),
            json={"name": "Ada Lovelace"},
        )
        assert first.status_code == 200

        response = client.put(
            f"/v1/admin/users/{target_id}/info",
            headers=_admin_headers(admin_id),
            json={"name": "Ada Lovelace"},
        )
    assert response.status_code == 200
    assert len(asyncio.run(_audit_events(target_id))) == 1


# --- PUT /v1/admin/users/{id}/admin-role (issue #149) ---


def test_set_admin_role_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/admin-role",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"isAdmin": True},
        )
    assert response.status_code == 403


def test_set_admin_role_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{uuid.uuid4()}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": True},
        )
    assert response.status_code == 404


def test_set_admin_role_rejects_self_revoke(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{admin_id}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": False},
        )
    assert response.status_code == 400
    assert asyncio.run(_user_is_admin(admin_id)) is True


def test_set_admin_role_allows_self_grant_as_noop(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{admin_id}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": True},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events(admin_id)) == []


def test_set_admin_role_grants_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": True},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": target_id, "isAdmin": True}
    assert asyncio.run(_user_is_admin(target_id)) is True

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].field == "isAdmin"
    assert events[0].oldValue == "false"
    assert events[0].newValue == "true"


def test_set_admin_role_revokes_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        first = client.put(
            f"/v1/admin/users/{target_id}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": True},
        )
        assert first.status_code == 200

        response = client.put(
            f"/v1/admin/users/{target_id}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": False},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": target_id, "isAdmin": False}
    assert asyncio.run(_user_is_admin(target_id)) is False

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 2
    assert events[1].oldValue == "true"
    assert events[1].newValue == "false"


def test_set_admin_role_is_a_noop_when_unchanged_and_writes_no_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/admin-role",
            headers=_admin_headers(admin_id),
            json={"isAdmin": False},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events(target_id)) == []


# --- GET/PUT /v1/admin/plan-defaults[/{plan}] (issue #140, bulk PUT #146) ---


def test_get_plan_defaults_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/plan-defaults",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
        )
    assert response.status_code == 403


def test_get_plan_defaults_returns_all_seeded_rows(admin_id):
    with TestClient(app) as client:
        response = client.get("/v1/admin/plan-defaults", headers=_admin_headers(admin_id))
    assert response.status_code == 200
    defaults = response.json()["defaults"]
    # 3 real Plans x 4 QuotaKinds, seeded by the #134 migration. ADMINISTRATEUR's
    # 4 rows were removed by #144's migration since that Plan is never
    # assigned again (docs/adr/0015).
    assert len(defaults) == 12
    assert not any(d["plan"] == "ADMINISTRATEUR" for d in defaults)


def test_set_plan_defaults_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"limits": {"DOCUMENTS_DAILY": 99}},
        )
    assert response.status_code == 403


def test_set_plan_defaults_404_for_plan_with_no_rows(admin_id):
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/ADMINISTRATEUR",
            headers=_admin_headers(admin_id),
            json={"limits": {"DOCUMENTS_DAILY": 99}},
        )
    assert response.status_code == 404


def test_set_plan_defaults_updates_only_changed_kinds_and_records_audit_events(
    admin_id, standard_documents_daily_cap
):
    standard_documents_daily_cap(20)
    unchanged_analyses_daily = asyncio.run(_plan_default(Plan.STANDARD, Quotakind.ANALYSES_DAILY))
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD",
            headers=_admin_headers(admin_id),
            json={"limits": {"DOCUMENTS_DAILY": 99, "ANALYSES_DAILY": unchanged_analyses_daily}},
        )
    assert response.status_code == 200
    documents_default = next(
        d for d in response.json()["defaults"] if d["quotaKind"] == "DOCUMENTS_DAILY"
    )
    assert documents_default == {"plan": "STANDARD", "quotaKind": "DOCUMENTS_DAILY", "limit": 99}
    assert asyncio.run(_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY)) == 99
    assert (
        asyncio.run(_plan_default(Plan.STANDARD, Quotakind.ANALYSES_DAILY))
        == unchanged_analyses_daily
    )

    events = asyncio.run(_audit_events_for_field("planQuotaDefault:STANDARD:DOCUMENTS_DAILY"))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId is None
    assert events[0].oldValue == "20"
    assert events[0].newValue == "99"
    assert asyncio.run(_audit_events_for_field("planQuotaDefault:STANDARD:ANALYSES_DAILY")) == []


def test_set_plan_defaults_to_null_means_unlimited(admin_id, standard_documents_daily_cap):
    standard_documents_daily_cap(20)
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD",
            headers=_admin_headers(admin_id),
            json={"limits": {"DOCUMENTS_DAILY": None}},
        )
    assert response.status_code == 200
    documents_default = next(
        d for d in response.json()["defaults"] if d["quotaKind"] == "DOCUMENTS_DAILY"
    )
    assert documents_default["limit"] is None
    assert asyncio.run(_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY)) is None


def test_set_plan_defaults_is_a_noop_when_unchanged_and_writes_no_audit_event(
    admin_id, standard_documents_daily_cap
):
    standard_documents_daily_cap(20)
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD",
            headers=_admin_headers(admin_id),
            json={"limits": {"DOCUMENTS_DAILY": 20}},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events_for_field("planQuotaDefault:STANDARD:DOCUMENTS_DAILY")) == []


def test_set_plan_defaults_propagates_live_to_non_overridden_user(
    admin_id, target_id, standard_documents_daily_cap
):
    standard_documents_daily_cap(20)
    # Effective Plan is now Subscription-derived (docs/adr/0018), so a
    # Subscription -- not the legacy `PUT .../plan` endpoint's User.plan
    # write -- is what puts target_id on STANDARD for this propagation check.
    asyncio.run(_give_active_subscription(target_id, Plan.STANDARD))
    with TestClient(app) as client:
        client.put(
            "/v1/admin/plan-defaults/STANDARD",
            headers=_admin_headers(admin_id),
            json={"limits": {"DOCUMENTS_DAILY": 77}},
        )
        response = client.get(
            f"/v1/admin/users/{target_id}/quotas",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    assert response.json()["quotas"]["DOCUMENTS_DAILY"]["cap"] == 77


# --- GET /v1/admin/users (issue #140) ---


def test_list_users_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/users",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
        )
    assert response.status_code == 403


def test_list_users_returns_lightweight_row_per_user(admin_id, target_id):
    with TestClient(app) as client:
        response = client.get("/v1/admin/users", headers=_admin_headers(admin_id), params={"pageSize": 100})
    assert response.status_code == 200
    body = response.json()
    users = {u["id"]: u for u in body["users"]}
    assert target_id in users
    assert users[target_id]["plan"] == "FREE"
    assert users[target_id]["isAdmin"] is False
    assert users[target_id]["blocked"] is False
    assert users[target_id]["atOrOverLimit"] is False
    assert "createdAt" in users[target_id]
    assert "quotas" not in users[target_id]
    assert body["total"] >= 2
    assert body["page"] == 1
    assert body["pageSize"] == 100


def test_list_users_filters_users_at_or_over_limit(admin_id, target_id, analyses_daily_cap):
    analyses_daily_cap(0)
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/users",
            headers=_admin_headers(admin_id),
            params={"atOrOverLimit": "true", "pageSize": 100},
        )
    assert response.status_code == 200
    body = response.json()["users"]
    user_ids = {u["id"] for u in body}
    assert target_id in user_ids
    assert all(u["atOrOverLimit"] is True for u in body)


def test_list_users_searches_by_name_or_email(admin_id):
    searchable_id = asyncio.run(_create_user(name="Ada Lovelace", email="ada@example.com"))
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/admin/users",
                headers=_admin_headers(admin_id),
                params={"search": "lovelace"},
            )
        assert response.status_code == 200
        ids = {u["id"] for u in response.json()["users"]}
        assert searchable_id in ids
    finally:
        asyncio.run(_delete_user(searchable_id))


def test_list_users_filters_by_plan_is_admin_and_blocked(admin_id):
    # Plan filter now reads Effective Plan (Subscription-derived,
    # docs/adr/0018), not the legacy User.plan column -- so the fixture
    # user's PREMIUM standing comes from a seeded Subscription, not `plan=`.
    premium_id = asyncio.run(_create_user())
    asyncio.run(_give_active_subscription(premium_id, Plan.PREMIUM))
    blocked_id = asyncio.run(_create_user(blocked=True))
    try:
        with TestClient(app) as client:
            plan_response = client.get(
                "/v1/admin/users",
                headers=_admin_headers(admin_id),
                params={"plan": "PREMIUM", "pageSize": 100},
            )
            blocked_response = client.get(
                "/v1/admin/users",
                headers=_admin_headers(admin_id),
                params={"blocked": "true", "pageSize": 100},
            )
            admin_response = client.get(
                "/v1/admin/users",
                headers=_admin_headers(admin_id),
                params={"isAdmin": "true", "pageSize": 100},
            )
        plan_ids = {u["id"] for u in plan_response.json()["users"]}
        assert premium_id in plan_ids
        blocked_ids = {u["id"] for u in blocked_response.json()["users"]}
        assert blocked_id in blocked_ids
        admin_ids = {u["id"] for u in admin_response.json()["users"]}
        assert admin_id in admin_ids
    finally:
        asyncio.run(_delete_user(premium_id))
        asyncio.run(_delete_user(blocked_id))


def test_list_users_sorts_by_requested_column(admin_id):
    a_id = asyncio.run(_create_user(name="AAA Sortable"))
    z_id = asyncio.run(_create_user(name="ZZZ Sortable"))
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/admin/users",
                headers=_admin_headers(admin_id),
                params={"search": "Sortable", "sortBy": "name", "sortDir": "asc"},
            )
        ids_in_order = [u["id"] for u in response.json()["users"]]
        assert ids_in_order.index(a_id) < ids_in_order.index(z_id)
    finally:
        asyncio.run(_delete_user(a_id))
        asyncio.run(_delete_user(z_id))


def test_list_users_paginates(admin_id):
    extra_ids = [asyncio.run(_create_user()) for _ in range(3)]
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/admin/users",
                headers=_admin_headers(admin_id),
                params={"page": 1, "pageSize": 1},
            )
        body = response.json()
        assert len(body["users"]) == 1
        assert body["page"] == 1
        assert body["pageSize"] == 1
        assert body["total"] >= 4
    finally:
        for uid in extra_ids:
            asyncio.run(_delete_user(uid))


# --- GET /v1/admin/stats (issue #140) ---


def test_get_stats_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/stats",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
        )
    assert response.status_code == 403


def test_get_stats_returns_aggregate_counts(admin_id, target_id, analyses_daily_cap):
    analyses_daily_cap(0)
    with TestClient(app) as client:
        response = client.get("/v1/admin/stats", headers=_admin_headers(admin_id))
    assert response.status_code == 200
    body = response.json()
    assert body["totalUsers"] >= 2
    assert body["usersOverLimitCount"] >= 1
    for key in (
        "analysesRequestedToday",
        "analysesRequestedThisMonth",
        "documentsCreatedToday",
        "activeScoutsTotal",
    ):
        assert isinstance(body[key], int)


def test_get_stats_rejects_invalid_period(admin_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/stats", headers=_admin_headers(admin_id), params={"period": "12h"}
        )
    assert response.status_code == 422


def test_get_stats_returns_signup_series_plan_distribution_and_blocked_count(admin_id):
    blocked_id = asyncio.run(_create_user(blocked=True))
    premium_id = asyncio.run(_create_user(plan=Plan.PREMIUM))
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/admin/stats", headers=_admin_headers(admin_id), params={"period": "30d"}
            )
        assert response.status_code == 200
        body = response.json()
        assert isinstance(body["newSignups"], list)
        assert all({"date", "count"} == set(point.keys()) for point in body["newSignups"])
        assert body["usersByPlan"]["PREMIUM"] >= 1
        assert body["blockedUsersCount"] >= 1
    finally:
        asyncio.run(_delete_user(blocked_id))
        asyncio.run(_delete_user(premium_id))


def test_get_stats_period_only_filters_new_signups(admin_id):
    old_id = asyncio.run(
        _create_user(
            plan=Plan.PREMIUM,
            blocked=True,
            created_at=datetime.now(UTC).replace(tzinfo=None) - timedelta(days=100),
        )
    )
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/admin/stats", headers=_admin_headers(admin_id), params={"period": "7d"}
            )
        body = response.json()
        signup_total = sum(point["count"] for point in body["newSignups"])
        # The 100-day-old signup must not be counted in a 7-day window...
        assert signup_total < body["totalUsers"]
        # ...but the snapshot figures (unaffected by `period`) still see it.
        assert body["usersByPlan"]["PREMIUM"] >= 1
        assert body["blockedUsersCount"] >= 1
    finally:
        asyncio.run(_delete_user(old_id))


# --- GET /v1/admin/users/{id}/audit-events (issue #150) ---


def test_get_audit_events_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            f"/v1/admin/users/{target_id}/audit-events",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
        )
    assert response.status_code == 403


def test_get_audit_events_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.get(
            f"/v1/admin/users/{uuid.uuid4()}/audit-events",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_get_audit_events_empty_when_none_recorded(admin_id, target_id):
    with TestClient(app) as client:
        response = client.get(
            f"/v1/admin/users/{target_id}/audit-events",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    assert response.json()["events"] == []


def test_get_audit_events_resolves_actor_and_returns_newest_first(admin_id, target_id):
    with TestClient(app) as client:
        client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "STANDARD", "duration": "MONTHLY"},
        )
        client.put(
            f"/v1/admin/users/{target_id}/blocked",
            headers=_admin_headers(admin_id),
            json={"blocked": True},
        )
        response = client.get(
            f"/v1/admin/users/{target_id}/audit-events",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    events = response.json()["events"]
    assert len(events) == 2
    # newest first: the blockedAt change (recorded second) comes before plan
    assert events[0]["field"] == "blockedAt"
    assert events[1]["field"] == "plan"
    for event in events:
        assert event["actor"]["id"] == admin_id
        assert event["actor"]["email"] is not None
        assert event["oldValue"] is not None or event["oldValue"] is None
        assert "createdAt" in event


def test_get_audit_events_only_includes_events_for_target_user(admin_id, target_id):
    other_id = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            client.put(
                f"/v1/admin/users/{target_id}/plan",
                headers=_admin_headers(admin_id),
                json={"plan": "STANDARD", "duration": "MONTHLY"},
            )
            client.put(
                f"/v1/admin/users/{other_id}/plan",
                headers=_admin_headers(admin_id),
                json={"plan": "STANDARD", "duration": "MONTHLY"},
            )
            response = client.get(
                f"/v1/admin/users/{target_id}/audit-events",
                headers=_admin_headers(admin_id),
            )
        events = response.json()["events"]
        assert len(events) == 1
    finally:
        asyncio.run(_delete_user(other_id))
