"""The admin-bootstrap script (`packages/py-db/scripts/create_admin.py`,
issue #156, docs/adr/0017): it must grant admin access via
`role = ADMINISTRATOR`. A new User it creates gets the same unbounded `free`
Subscription sign-up gives (docs/adr/0018); promoting an existing User leaves
their Subscriptions untouched. Issue #257 makes it usable by `make setup`:
inputs from flags or ADMIN_* env vars, and a `--check` for "does any
Administrator exist?". Loaded by file path since it's a standalone script,
not a py_db package module.
"""

import asyncio
import importlib.util
import uuid
from pathlib import Path

import pytest
from py_db.models import Plan, Role, Subscription, User
from py_db.session import make_engine, make_session_factory
from py_db.passwords import verify_password
from sqlalchemy import delete, select, update

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


async def _subscriptions_of(email: str) -> list[Subscription]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            user = await session.scalar(select(User).where(User.email == email))
            return list(
                (await session.scalars(select(Subscription).where(Subscription.userId == user.id))).all()
            )
    finally:
        await engine.dispose()


async def _set_role(user_ids: list[str], role: Role) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(update(User).where(User.id.in_(user_ids)).values(role=role))
            await session.commit()
    finally:
        await engine.dispose()


async def _administrator_ids() -> list[str]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return list((await session.scalars(select(User.id).where(User.role == Role.ADMINISTRATOR))).all())
    finally:
        await engine.dispose()


@pytest.fixture
def no_administrator():
    """Demotes every Administrator the shared test database holds for the
    duration of one test, then restores them."""
    admin_ids = asyncio.run(_administrator_ids())
    asyncio.run(_set_role(admin_ids, Role.EXTERNAL))
    yield
    asyncio.run(_set_role(admin_ids, Role.ADMINISTRATOR))


@pytest.fixture
def no_admin_env(monkeypatch):
    for var in ("ADMIN_EMAIL", "ADMIN_NAME", "ADMIN_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


def test_a_new_admin_gets_exactly_one_unbounded_free_subscription(email):
    create_admin = _load_create_admin_module()
    asyncio.run(create_admin.create_or_promote_admin(email, "New Admin", "a real password"))

    subscriptions = asyncio.run(_subscriptions_of(email))
    assert len(subscriptions) == 1
    assert subscriptions[0].plan == Plan.FREE
    assert subscriptions[0].endDate is None


def test_main_reads_its_inputs_from_the_environment(email, no_admin_env):
    create_admin = _load_create_admin_module()
    no_admin_env.setenv("ADMIN_EMAIL", email)
    no_admin_env.setenv("ADMIN_NAME", "Env Admin")
    no_admin_env.setenv("ADMIN_PASSWORD", "an env password")

    assert create_admin.main([]) == 0

    user = asyncio.run(_get_user(email))
    assert user is not None
    assert user.role == Role.ADMINISTRATOR
    assert user.name == "Env Admin"
    assert verify_password("an env password", user.passwordHash)


def test_main_flags_win_over_the_environment(email, no_admin_env):
    create_admin = _load_create_admin_module()
    no_admin_env.setenv("ADMIN_EMAIL", f"other-{email}")
    no_admin_env.setenv("ADMIN_NAME", "Env Admin")
    no_admin_env.setenv("ADMIN_PASSWORD", "an env password")

    assert create_admin.main(["--email", email, "--name", "Flag Admin", "--password", "a flag password"]) == 0

    user = asyncio.run(_get_user(email))
    assert user.name == "Flag Admin"
    assert verify_password("a flag password", user.passwordHash)
    assert asyncio.run(_get_user(f"other-{email}")) is None


def test_main_never_prints_the_password(email, no_admin_env, capsys):
    create_admin = _load_create_admin_module()

    create_admin.main(["--email", email, "--name", "Admin", "--password", "s3cret-never-shown"])

    out, err = capsys.readouterr()
    assert email in out
    assert "s3cret-never-shown" not in out + err


def test_main_fails_clearly_when_an_input_is_missing(email, no_admin_env, capsys):
    create_admin = _load_create_admin_module()
    no_admin_env.setenv("ADMIN_EMAIL", email)
    no_admin_env.setenv("ADMIN_NAME", "Admin")

    with pytest.raises(SystemExit) as exc:
        create_admin.main([])

    assert exc.value.code == 2
    _, err = capsys.readouterr()
    assert "--password" in err
    assert "ADMIN_PASSWORD" in err
    assert asyncio.run(_get_user(email)) is None


def test_check_exits_0_when_an_administrator_exists(email, no_admin_env, capsys):
    create_admin = _load_create_admin_module()
    asyncio.run(create_admin.create_or_promote_admin(email, "Admin", "a real password"))

    assert create_admin.main(["--check"]) == 0
    assert "exists" in capsys.readouterr().out


def test_check_exits_with_a_distinct_code_when_no_administrator_exists(no_administrator, no_admin_env, capsys):
    create_admin = _load_create_admin_module()

    assert create_admin.main(["--check"]) == create_admin.NO_ADMINISTRATOR_EXIT_CODE
    assert create_admin.NO_ADMINISTRATOR_EXIT_CODE not in (0, 1, 2)
    assert "No Administrator" in capsys.readouterr().out
