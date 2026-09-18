#!/usr/bin/env python3
"""One-off bootstrap for the very first Administrator.

Every other way to become an Administrator (`PUT /v1/admin/users/{id}/role`,
issue #156) requires the caller to already be one — this script is how the
first account is created, since there's no other path in. Also works to
create additional Administrators later, or to (re)set an existing User's
password.

Admin access is granted via `role = ADMINISTRATOR` (issue #156, docs/adr/0017,
replacing the retired `isAdmin` boolean from issue #144), never by assigning
the vestigial `administrateur` Plan — a new User created here keeps a real
Plan (`free` by default) alongside admin rights; promoting an existing User
leaves their current Plan untouched.

Usage:
    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/job_hunt_crew \\
        uv run --package py-db python scripts/create_admin.py \\
        --email you@example.com --name "Your Name" --password 'a real password'
"""

import argparse
import asyncio
import os
import uuid
from datetime import UTC, datetime

from py_db.models import Role, User
from py_db.passwords import hash_password
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/job_hunt_crew")
    asyncio.run(create_or_promote_admin(args.email, args.name, args.password))


if __name__ == "__main__":
    main()
