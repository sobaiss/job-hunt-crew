"""The shared quota-resolution helper (`py_db.quotas.effective_quota`),
introduced in issue #135 so every quota-consuming action reads its ceiling
from one place. Covers the override-vs-Plan-default precedence (docs/adr/0013)
exhaustively here; each HTTP call site's own test only needs one thin case
confirming it honors this function's answer.
"""

import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import Plan, Quotakind, QuotaOverride, User
from py_db.quotas import effective_quota
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_falls_back_to_plan_default_when_no_override():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(
                User(id=user_id, email=f"{user_id}@example.com", plan=Plan.STANDARD, updatedAt=_now())
            )
            await session.commit()

        async with session_factory() as session:
            # STANDARD's seeded PlanQuotaDefault for ANALYSES_DAILY is 50.
            assert await effective_quota(session, user_id, Quotakind.ANALYSES_DAILY) == 50
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_override_takes_precedence_over_plan_default():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(
                User(id=user_id, email=f"{user_id}@example.com", plan=Plan.STANDARD, updatedAt=_now())
            )
            session.add(
                QuotaOverride(
                    id=str(uuid.uuid4()),
                    userId=user_id,
                    quotaKind=Quotakind.ANALYSES_DAILY,
                    limit=7,
                    updatedAt=_now(),
                )
            )
            await session.commit()

        async with session_factory() as session:
            # Override wins even though STANDARD's default for this kind is 50.
            assert await effective_quota(session, user_id, Quotakind.ANALYSES_DAILY) == 7
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_null_override_means_unlimited_even_with_a_numeric_plan_default():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(
                User(id=user_id, email=f"{user_id}@example.com", plan=Plan.FREE, updatedAt=_now())
            )
            session.add(
                QuotaOverride(
                    id=str(uuid.uuid4()),
                    userId=user_id,
                    quotaKind=Quotakind.ACTIVE_SCOUTS,
                    limit=None,
                    updatedAt=_now(),
                )
            )
            await session.commit()

        async with session_factory() as session:
            # FREE's seeded ACTIVE_SCOUTS default is 2, but the explicit
            # override row (limit=None) makes this User unlimited.
            assert await effective_quota(session, user_id, Quotakind.ACTIVE_SCOUTS) is None
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_administrateur_plan_default_is_unlimited_on_every_kind():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(
                User(
                    id=user_id,
                    email=f"{user_id}@example.com",
                    plan=Plan.ADMINISTRATEUR,
                    updatedAt=_now(),
                )
            )
            await session.commit()

        async with session_factory() as session:
            for kind in Quotakind:
                assert await effective_quota(session, user_id, kind) is None
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()
