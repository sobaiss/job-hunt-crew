import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


async def _create_user() -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                User(
                    id=user_id,
                    email=f"{user_id}@example.com",
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


def test_admin_route_rejects_caller_with_no_plan_header(user_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Id": user_id},
        )
    assert response.status_code == 403


def test_admin_route_rejects_non_administrator_plan(user_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Id": user_id, "X-User-Plan": "STANDARD"},
        )
    assert response.status_code == 403


def test_admin_route_rejects_missing_user_id():
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Plan": "ADMINISTRATEUR"},
        )
    assert response.status_code == 401


def test_admin_route_allows_administrator_plan(user_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/me",
            headers={**HEADERS, "X-User-Id": user_id, "X-User-Plan": "ADMINISTRATEUR"},
        )
    assert response.status_code == 200
    assert response.json() == {"userId": user_id, "plan": "ADMINISTRATEUR"}
