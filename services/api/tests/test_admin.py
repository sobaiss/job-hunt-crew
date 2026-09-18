import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import Plan, PlanQuotaDefault, Quotakind, AdminAuditEvent, QuotaOverride, User
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
) -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                User(
                    id=user_id,
                    name=name,
                    email=email or f"{user_id}@example.com",
                    plan=plan,
                    isAdmin=is_admin,
                    blockedAt=datetime.now(UTC).replace(tzinfo=None) if blocked else None,
                    updatedAt=datetime.now(UTC).replace(tzinfo=None),
                )
            )
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


async def _user_plan(user_id: str) -> Plan:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(select(User.plan).where(User.id == user_id))
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


# --- PUT /v1/admin/users/{id}/plan (issue #139) ---


def test_set_plan_requires_admin(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"plan": "PREMIUM"},
        )
    assert response.status_code == 403


def test_set_plan_404_for_unknown_user(admin_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{uuid.uuid4()}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "PREMIUM"},
        )
    assert response.status_code == 404


def test_set_plan_reassigns_plan_and_records_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "PREMIUM"},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": target_id, "plan": "PREMIUM"}
    assert asyncio.run(_user_plan(target_id)) == Plan.PREMIUM

    events = asyncio.run(_audit_events(target_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].field == "plan"
    assert events[0].oldValue == "FREE"
    assert events[0].newValue == "PREMIUM"


def test_set_plan_is_a_noop_when_unchanged_and_writes_no_audit_event(admin_id, target_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "FREE"},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events(target_id)) == []


# --- GET/PUT /v1/admin/plan-defaults[/{plan}/{kind}] (issue #140) ---


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


def test_set_plan_default_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD/DOCUMENTS_DAILY",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Is-Admin": "false"},
            json={"limit": 99},
        )
    assert response.status_code == 403


def test_set_plan_default_updates_limit_and_records_audit_event(
    admin_id, standard_documents_daily_cap
):
    standard_documents_daily_cap(20)
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD/DOCUMENTS_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 99},
        )
    assert response.status_code == 200
    assert response.json() == {"plan": "STANDARD", "quotaKind": "DOCUMENTS_DAILY", "limit": 99}
    assert asyncio.run(_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY)) == 99

    events = asyncio.run(_audit_events_for_field("planQuotaDefault:STANDARD:DOCUMENTS_DAILY"))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId is None
    assert events[0].oldValue == "20"
    assert events[0].newValue == "99"


def test_set_plan_default_to_null_means_unlimited(admin_id, standard_documents_daily_cap):
    standard_documents_daily_cap(20)
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD/DOCUMENTS_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": None},
        )
    assert response.status_code == 200
    assert response.json()["limit"] is None
    assert asyncio.run(_plan_default(Plan.STANDARD, Quotakind.DOCUMENTS_DAILY)) is None


def test_set_plan_default_is_a_noop_when_unchanged_and_writes_no_audit_event(
    admin_id, standard_documents_daily_cap
):
    standard_documents_daily_cap(20)
    with TestClient(app) as client:
        response = client.put(
            "/v1/admin/plan-defaults/STANDARD/DOCUMENTS_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 20},
        )
    assert response.status_code == 200
    assert asyncio.run(_audit_events_for_field("planQuotaDefault:STANDARD:DOCUMENTS_DAILY")) == []


def test_set_plan_default_propagates_live_to_non_overridden_user(
    admin_id, target_id, standard_documents_daily_cap
):
    standard_documents_daily_cap(20)
    with TestClient(app) as client:
        client.put(
            f"/v1/admin/users/{target_id}/plan",
            headers=_admin_headers(admin_id),
            json={"plan": "STANDARD"},
        )
        client.put(
            "/v1/admin/plan-defaults/STANDARD/DOCUMENTS_DAILY",
            headers=_admin_headers(admin_id),
            json={"limit": 77},
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
    premium_id = asyncio.run(_create_user(plan=Plan.PREMIUM))
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
