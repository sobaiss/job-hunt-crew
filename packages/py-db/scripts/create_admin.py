#!/usr/bin/env python3
"""Bootstrap for the very first Administrator.

Every other way to become an Administrator (`PUT /v1/admin/users/{id}/role`,
issue #156) requires the caller to already be one — this script is how the
first account is created, since there's no other path in. Also works to
create additional Administrators later, or to (re)set an existing User's
password.

Admin access is granted via `role = ADMINISTRATOR` (issue #156, docs/adr/0017,
replacing the retired `isAdmin` boolean from issue #144). A new User created
here gets the same unbounded `free` Subscription sign-up gives every User
(docs/adr/0018, issue #257); promoting an existing User leaves their
Subscriptions untouched.

Inputs come from --email / --name / --password, or from ADMIN_EMAIL /
ADMIN_NAME / ADMIN_PASSWORD when a flag isn't given (how `make setup` passes
them, so the password never appears on a command line). The password is
never printed. `--check` only reports whether any Administrator exists:
exit 0 if one does, NO_ADMINISTRATOR_EXIT_CODE if none.

Usage, inside the `api` container (no host Python needed):
    docker compose run --rm -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD api \\
        uv run --package api python packages/py-db/scripts/create_admin.py
    docker compose run --rm api \\
        uv run --package api python packages/py-db/scripts/create_admin.py --check

Or from the host:
    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/job_hunt_crew \\
        uv run --package py-db python packages/py-db/scripts/create_admin.py \\
        --email you@example.com --name "Your Name" --password 'a real password'
"""

import argparse
import asyncio
import os
import uuid
from datetime import UTC, datetime

from py_db.models import Plan, Role, Subscription, User
from py_db.passwords import hash_password
from py_db.session import make_engine, make_session_factory
from sqlalchemy import exists, select

# Distinct from 0 (an Administrator exists), 1 (an unhandled error, e.g. the
# database is unreachable) and 2 (argparse's usage error), so a caller can
# tell "none yet" apart from "couldn't tell".
NO_ADMINISTRATOR_EXIT_CODE = 3

_INPUTS = (("email", "ADMIN_EMAIL"), ("name", "ADMIN_NAME"), ("password", "ADMIN_PASSWORD"))


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def create_or_promote_admin(email: str, name: str, password: str) -> None:
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            user = await session.scalar(select(User).where(User.email == email))
            if user is None:
                user = User(id=str(uuid.uuid4()), email=email, updatedAt=_now())
                session.add(user)
                # Same as the sign-up path (internal.upsert_user, #154).
                session.add(
                    Subscription(id=str(uuid.uuid4()), userId=user.id, plan=Plan.FREE, startDate=_now())
                )
                action = "Created"
            else:
                action = "Updated"
            user.name = name
            user.role = Role.ADMINISTRATOR
            user.passwordHash = hash_password(password)
            user.updatedAt = _now()
            await session.commit()
            print(f"{action} Administrator {email} (id={user.id}).")
    finally:
        await engine.dispose()


async def administrator_exists() -> bool:
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            return bool(await session.scalar(select(exists().where(User.role == Role.ADMINISTRATOR))))
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--email")
    parser.add_argument("--name")
    parser.add_argument("--password")
    parser.add_argument(
        "--check",
        action="store_true",
        help=f"only report whether any Administrator exists (exit 0 if so, {NO_ADMINISTRATOR_EXIT_CODE} if not)",
    )
    args = parser.parse_args(argv)

    os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/job_hunt_crew")

    if args.check:
        if asyncio.run(administrator_exists()):
            print("An Administrator exists.")
            return 0
        print("No Administrator exists yet.")
        return NO_ADMINISTRATOR_EXIT_CODE

    values = {field: getattr(args, field) or os.environ.get(var) for field, var in _INPUTS}
    missing = [f"--{field} (or {var})" for field, var in _INPUTS if not values[field]]
    if missing:
        parser.error(f"missing {', '.join(missing)}")

    asyncio.run(create_or_promote_admin(values["email"], values["name"], values["password"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
