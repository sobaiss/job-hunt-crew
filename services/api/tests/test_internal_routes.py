import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import User, t_VerificationToken
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


async def _delete_user_by_email(email: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.email == email))
            await session.commit()
    finally:
        await engine.dispose()


async def _delete_verification_token(identifier: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(
                delete(t_VerificationToken).where(t_VerificationToken.c.identifier == identifier)
            )
            await session.commit()
    finally:
        await engine.dispose()


def test_upsert_user_same_email_twice_returns_same_user_id():
    email = f"upsert-{uuid.uuid4()}@example.com"
    try:
        # A single `with` block keeps one event loop/portal alive across both
        # requests — each request's asyncpg connection is bound to the loop
        # that created it, so issuing the two requests on separate implicit
        # loops (no context manager) breaks the second one.
        with TestClient(app) as client:
            first = client.post(
                "/internal/users/upsert",
                json={"email": email, "name": "Ada Lovelace"},
                headers=HEADERS,
            )
            second = client.post(
                "/internal/users/upsert",
                json={"email": email, "name": "Ada L."},
                headers=HEADERS,
            )
        assert first.status_code == 200
        assert second.status_code == 200
        user_id = first.json()["userId"]
        assert user_id
        assert second.json()["userId"] == user_id
    finally:
        asyncio.run(_delete_user_by_email(email))


def test_upsert_user_requires_internal_secret():
    client = TestClient(app)
    email = f"unauth-{uuid.uuid4()}@example.com"
    try:
        response = client.post("/internal/users/upsert", json={"email": email})
        assert response.status_code == 401
    finally:
        asyncio.run(_delete_user_by_email(email))


def test_verification_token_create_then_consume_is_single_use():
    identifier = f"consume-{uuid.uuid4()}@example.com"
    token = str(uuid.uuid4())
    expires = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    try:
        with TestClient(app) as client:
            created = client.post(
                "/internal/auth/verification-tokens",
                json={"identifier": identifier, "token": token, "expires": expires},
                headers=HEADERS,
            )
            first_consume = client.post(
                "/internal/auth/verification-tokens/consume",
                json={"identifier": identifier, "token": token},
                headers=HEADERS,
            )
            second_consume = client.post(
                "/internal/auth/verification-tokens/consume",
                json={"identifier": identifier, "token": token},
                headers=HEADERS,
            )
        assert created.status_code == 201
        assert created.json()["identifier"] == identifier
        assert created.json()["token"] == token

        assert first_consume.status_code == 200
        assert first_consume.json()["identifier"] == identifier
        assert first_consume.json()["token"] == token

        assert second_consume.status_code == 404
    finally:
        asyncio.run(_delete_verification_token(identifier))


def test_consume_unknown_verification_token_returns_404():
    identifier = f"unknown-{uuid.uuid4()}@example.com"
    with TestClient(app) as client:
        response = client.post(
            "/internal/auth/verification-tokens/consume",
            json={"identifier": identifier, "token": "does-not-exist"},
            headers=HEADERS,
        )
    assert response.status_code == 404
