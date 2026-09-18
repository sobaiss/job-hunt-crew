"""Global blocking enforcement (issue #144, docs/adr/0016): every
authenticated call into services/api, not only `/v1/admin/*` ones, is
rejected when the caller's `blockedAt` is set. This is checked live against
Postgres inside the shared `require_user_id` dependency, so a single test
against an ordinary, non-admin endpoint (GET /v1/scouts) is proof the
enforcement is global rather than scoped to the admin router.
"""

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, update

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _create_user() -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            await session.commit()
    finally:
        await engine.dispose()
    return user_id


async def _set_blocked(user_id: str, blocked: bool) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(
                update(User)
                .where(User.id == user_id)
                .values(blockedAt=_now() if blocked else None)
            )
            await session.commit()
    finally:
        await engine.dispose()


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


def _headers(user_id: str) -> dict[str, str]:
    return {**HEADERS, "X-User-Id": user_id}


def test_blocked_user_is_rejected_on_an_ordinary_non_admin_endpoint(user_id):
    asyncio.run(_set_blocked(user_id, True))
    with TestClient(app) as client:
        response = client.get("/v1/scouts", headers=_headers(user_id))
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "USER_BLOCKED"


def test_unblocked_user_is_not_rejected(user_id):
    with TestClient(app) as client:
        response = client.get("/v1/scouts", headers=_headers(user_id))
    assert response.status_code == 200


def test_a_previously_blocked_then_unblocked_user_is_allowed_again(user_id):
    asyncio.run(_set_blocked(user_id, True))
    asyncio.run(_set_blocked(user_id, False))
    with TestClient(app) as client:
        response = client.get("/v1/scouts", headers=_headers(user_id))
    assert response.status_code == 200
