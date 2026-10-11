import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import Plan, PlanQuotaDefault, QuotaOverride, Quotakind, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select, update

from api.main import app

INTERNAL_SECRET_HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _plan_defaults() -> dict[tuple[Plan, Quotakind], int | None]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            rows = (await session.scalars(select(PlanQuotaDefault))).all()
            return {(row.plan, row.quotaKind): row.limit for row in rows}
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
def set_plan_default():
    """Lets a test change any `PlanQuotaDefault`, restoring every original
    limit afterwards so the seeded values survive for the other test files.
    """
    original = asyncio.run(_plan_defaults())

    def _apply(plan: Plan, kind: Quotakind, limit: int | None) -> None:
        asyncio.run(_set_plan_default(plan, kind, limit))

    yield _apply
    for (plan, kind), limit in original.items():
        asyncio.run(_set_plan_default(plan, kind, limit))


async def _create_user_with_override(kind: Quotakind, limit: int | None) -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            await session.flush()
            session.add(
                QuotaOverride(
                    id=str(uuid.uuid4()),
                    userId=user_id,
                    quotaKind=kind,
                    limit=limit,
                    updatedAt=_now(),
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


def _set_all(set_plan_default, plan: Plan, limits: tuple[int | None, ...]) -> None:
    kinds = (
        Quotakind.ACTIVE_SCOUTS,
        Quotakind.ANALYSES_DAILY,
        Quotakind.ANALYSES_MONTHLY,
        Quotakind.DOCUMENTS_DAILY,
    )
    for kind, limit in zip(kinds, limits, strict=True):
        set_plan_default(plan, kind, limit)


def _quotas(limits: tuple[int | None, ...]) -> dict[str, int | None]:
    return dict(
        zip(
            ("ACTIVE_SCOUTS", "ANALYSES_DAILY", "ANALYSES_MONTHLY", "DOCUMENTS_DAILY"),
            limits,
            strict=True,
        )
    )


def test_get_plans_returns_the_three_plans_in_order_with_their_defaults(set_plan_default):
    _set_all(set_plan_default, Plan.FREE, (2, 15, 300, 5))
    _set_all(set_plan_default, Plan.STANDARD, (5, 50, 1000, 20))
    _set_all(set_plan_default, Plan.PREMIUM, (15, 150, 3000, 60))
    with TestClient(app) as client:
        response = client.get("/v1/plans", headers=INTERNAL_SECRET_HEADERS)
    assert response.status_code == 200
    assert response.json() == {
        "plans": [
            {"plan": "free", "quotas": _quotas((2, 15, 300, 5))},
            {"plan": "standard", "quotas": _quotas((5, 50, 1000, 20))},
            {"plan": "premium", "quotas": _quotas((15, 150, 3000, 60))},
        ]
    }


def test_get_plans_reflects_a_default_changed_in_the_database(set_plan_default):
    with TestClient(app) as client:
        set_plan_default(Plan.STANDARD, Quotakind.ANALYSES_DAILY, 7)
        first = client.get("/v1/plans", headers=INTERNAL_SECRET_HEADERS).json()
        set_plan_default(Plan.STANDARD, Quotakind.ANALYSES_DAILY, 8)
        second = client.get("/v1/plans", headers=INTERNAL_SECRET_HEADERS).json()
    assert first["plans"][1]["quotas"]["ANALYSES_DAILY"] == 7
    assert second["plans"][1]["quotas"]["ANALYSES_DAILY"] == 8


def test_get_plans_returns_an_unlimited_default_as_null(set_plan_default):
    set_plan_default(Plan.PREMIUM, Quotakind.DOCUMENTS_DAILY, None)
    with TestClient(app) as client:
        body = client.get("/v1/plans", headers=INTERNAL_SECRET_HEADERS).json()
    assert body["plans"][2]["quotas"]["DOCUMENTS_DAILY"] is None


def test_get_plans_ignores_quota_overrides(set_plan_default):
    set_plan_default(Plan.FREE, Quotakind.ACTIVE_SCOUTS, 2)
    user_id = asyncio.run(_create_user_with_override(Quotakind.ACTIVE_SCOUTS, 99))
    try:
        with TestClient(app) as client:
            # Even the overridden user's own id must not change the answer.
            for headers in (
                INTERNAL_SECRET_HEADERS,
                {**INTERNAL_SECRET_HEADERS, "X-User-Id": user_id},
            ):
                body = client.get("/v1/plans", headers=headers).json()
                assert body["plans"][0]["quotas"]["ACTIVE_SCOUTS"] == 2
    finally:
        asyncio.run(_delete_user(user_id))


def test_get_plans_responds_without_user_id_but_requires_the_internal_secret():
    with TestClient(app) as client:
        assert client.get("/v1/plans", headers=INTERNAL_SECRET_HEADERS).status_code == 200
        assert client.get("/v1/plans").status_code == 401
