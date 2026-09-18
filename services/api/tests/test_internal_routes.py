import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import User, t_VerificationToken
from py_db.passwords import hash_password
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


async def _create_user(email: str, *, password: str | None = None) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                User(
                    id=str(uuid.uuid4()),
                    email=email,
                    passwordHash=hash_password(password) if password else None,
                    updatedAt=datetime.now(UTC).replace(tzinfo=None),
                )
            )
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


def test_upsert_user_returns_new_users_plan():
    # New Users default to FREE (issue #135); the response carries `plan` so
    # apps/web's `jwt` callback can stash it without ever querying Postgres
    # directly (issue #138).
    email = f"plan-{uuid.uuid4()}@example.com"
    try:
        with TestClient(app) as client:
            response = client.post(
                "/internal/users/upsert",
                json={"email": email},
                headers=HEADERS,
            )
        assert response.status_code == 200
        assert response.json()["plan"] == "FREE"
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


def test_verify_credentials_with_correct_password_returns_user():
    email = f"creds-ok-{uuid.uuid4()}@example.com"
    try:
        asyncio.run(_create_user(email, password="correct horse battery staple"))
        with TestClient(app) as client:
            response = client.post(
                "/internal/auth/verify-credentials",
                json={"email": email, "password": "correct horse battery staple"},
                headers=HEADERS,
            )
        assert response.status_code == 200
        assert response.json()["userId"]
        assert response.json()["plan"] == "FREE"
    finally:
        asyncio.run(_delete_user_by_email(email))


def test_verify_credentials_with_wrong_password_returns_401():
    email = f"creds-wrong-{uuid.uuid4()}@example.com"
    try:
        asyncio.run(_create_user(email, password="correct horse battery staple"))
        with TestClient(app) as client:
            response = client.post(
                "/internal/auth/verify-credentials",
                json={"email": email, "password": "not the right password"},
                headers=HEADERS,
            )
        assert response.status_code == 401
    finally:
        asyncio.run(_delete_user_by_email(email))


def test_verify_credentials_unknown_email_returns_401():
    with TestClient(app) as client:
        response = client.post(
            "/internal/auth/verify-credentials",
            json={"email": f"no-such-user-{uuid.uuid4()}@example.com", "password": "anything"},
            headers=HEADERS,
        )
    assert response.status_code == 401


def test_verify_credentials_user_with_no_password_set_returns_401():
    # An OAuth/magic-link-only User (issue #135's foundation predates this
    # column existing at all for pre-existing rows) has no passwordHash — the
    # Credentials provider must reject it exactly like a wrong password, not
    # error out.
    email = f"no-password-{uuid.uuid4()}@example.com"
    try:
        asyncio.run(_create_user(email, password=None))
        with TestClient(app) as client:
            response = client.post(
                "/internal/auth/verify-credentials",
                json={"email": email, "password": "anything"},
                headers=HEADERS,
            )
        assert response.status_code == 401
    finally:
        asyncio.run(_delete_user_by_email(email))
