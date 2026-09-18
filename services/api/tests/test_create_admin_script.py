"""The admin-bootstrap script (`packages/py-db/scripts/create_admin.py`,
issue #156, docs/adr/0017): it must grant admin access via
`role = ADMINISTRATOR`, and never touch Plan/Subscription. Loaded by file
path since it's a standalone script, not a py_db package module.
"""

import asyncio
import importlib.util
import uuid
from pathlib import Path

import pytest
from py_db.models import Plan, Role, Subscription, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[3] / "packages" / "py-db" / "scripts" / "create_admin.py"
)


def _load_create_admin_module():
    spec = importlib.util.spec_from_file_location("create_admin", _SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _get_user(email: str) -> User | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(select(User).where(User.email == email))
    finally:
        await engine.dispose()


async def _delete_user_by_email(email: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.email == email))
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def email():
    addr = f"{uuid.uuid4()}@example.com"
    yield addr
    asyncio.run(_delete_user_by_email(addr))


def test_creates_a_new_admin_with_administrator_role(email):
    create_admin = _load_create_admin_module()
    asyncio.run(create_admin.create_or_promote_admin(email, "New Admin", "a real password"))

    user = asyncio.run(_get_user(email))
    assert user is not None
    assert user.role == Role.ADMINISTRATOR


def test_promoting_an_existing_user_leaves_their_subscription_untouched(email):
    create_admin = _load_create_admin_module()

    async def _seed() -> str:
        engine = make_engine()
        try:
            session_factory = make_session_factory(engine)
            async with session_factory() as session:
                from datetime import UTC, datetime

                user_id = str(uuid.uuid4())
                now = datetime.now(UTC).replace(tzinfo=None)
                session.add(User(id=user_id, email=email, updatedAt=now))
                session.add(
                    Subscription(
                        id=str(uuid.uuid4()), userId=user_id, plan=Plan.STANDARD, startDate=now
                    )
                )
                await session.commit()
                return user_id
        finally:
            await engine.dispose()

    seeded_user_id = asyncio.run(_seed())
    asyncio.run(create_admin.create_or_promote_admin(email, "Promoted Admin", "a real password"))

    user = asyncio.run(_get_user(email))
    assert user is not None
    assert user.role == Role.ADMINISTRATOR

    async def _subscriptions() -> list[Subscription]:
        engine = make_engine()
        try:
            session_factory = make_session_factory(engine)
            async with session_factory() as session:
                return list(
                    (
                        await session.scalars(
                            select(Subscription).where(Subscription.userId == seeded_user_id)
                        )
                    ).all()
                )
        finally:
            await engine.dispose()

    subscriptions = asyncio.run(_subscriptions())
    assert len(subscriptions) == 1
