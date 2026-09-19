"""The shared quota-resolution helpers (`py_db.quotas.effective_plan`,
introduced in issue #153/docs/adr/0018, and `py_db.quotas.effective_quota`,
introduced in issue #135) so every quota-consuming action reads its ceiling
from one place. Covers the override-vs-Plan-default precedence (docs/adr/0013)
and the Subscription-vs-Effective-Plan derivation (docs/adr/0018)
exhaustively here; each HTTP call site's own test only needs one thin case
confirming it honors this function's answer.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from py_db.models import Duration, Plan, Quotakind, QuotaOverride, Subscription, User
from py_db.quotas import effective_plan, effective_quota
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _subscription(
    user_id: str,
    plan: Plan,
    *,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    duration: Duration | None = None,
) -> Subscription:
    return Subscription(
        id=str(uuid.uuid4()),
        userId=user_id,
        plan=plan,
        startDate=start_date if start_date is not None else _now(),
        endDate=end_date,
        duration=duration,
    )


@pytest.mark.asyncio
async def test_falls_back_to_plan_default_when_no_override():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(_subscription(user_id, Plan.STANDARD))
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
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(_subscription(user_id, Plan.STANDARD))
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
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(_subscription(user_id, Plan.STANDARD))
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
            # STANDARD's seeded ACTIVE_SCOUTS default is 5, but the explicit
            # override row (limit=None) makes this User unlimited.
            assert await effective_quota(session, user_id, Quotakind.ACTIVE_SCOUTS) is None
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_free_plan_default_matches_reinstated_ceilings():
    """docs/adr/0021: `free`'s PlanQuotaDefault was reinstated to its
    original #135 seed values, reversing the unlimited-on-every-kind state
    docs/adr/0018's migration left it in ("Free is free") — an undocumented
    side effect of that migration, not a decision of docs/adr/0018 itself.
    """
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(_subscription(user_id, Plan.FREE))
            await session.commit()

        async with session_factory() as session:
            expected = {
                Quotakind.ACTIVE_SCOUTS: 2,
                Quotakind.ANALYSES_DAILY: 15,
                Quotakind.ANALYSES_MONTHLY: 300,
                Quotakind.DOCUMENTS_DAILY: 5,
            }
            for kind in Quotakind:
                assert await effective_quota(session, user_id, kind) == expected[kind]
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


# --- effective_plan (issue #153/docs/adr/0018) ---


@pytest.mark.asyncio
async def test_effective_plan_is_free_with_no_subscription():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            await session.commit()

        async with session_factory() as session:
            assert await effective_plan(session, user_id) == Plan.FREE
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_effective_plan_honors_an_active_unbounded_free_subscription():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(_subscription(user_id, Plan.FREE, start_date=_now() - timedelta(days=1)))
            await session.commit()

        async with session_factory() as session:
            assert await effective_plan(session, user_id) == Plan.FREE
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_effective_plan_honors_an_active_dated_premium_subscription():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(
                _subscription(
                    user_id,
                    Plan.PREMIUM,
                    start_date=_now() - timedelta(days=1),
                    end_date=_now() + timedelta(days=30),
                    duration=Duration.MONTHLY,
                )
            )
            await session.commit()

        async with session_factory() as session:
            assert await effective_plan(session, user_id) == Plan.PREMIUM
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_effective_plan_falls_back_to_free_when_lapsed_with_nothing_after():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            session.add(
                _subscription(
                    user_id,
                    Plan.PREMIUM,
                    start_date=_now() - timedelta(days=400),
                    end_date=_now() - timedelta(days=35),
                    duration=Duration.YEARLY,
                )
            )
            await session.commit()

        async with session_factory() as session:
            assert await effective_plan(session, user_id) == Plan.FREE
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_effective_plan_picks_the_later_subscription_after_a_lapse():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            # A lapsed Standard subscription, then a later, still-active Premium one.
            session.add(
                _subscription(
                    user_id,
                    Plan.STANDARD,
                    start_date=_now() - timedelta(days=400),
                    end_date=_now() - timedelta(days=35),
                    duration=Duration.YEARLY,
                )
            )
            session.add(
                _subscription(
                    user_id,
                    Plan.PREMIUM,
                    start_date=_now() - timedelta(days=1),
                    end_date=_now() + timedelta(days=30),
                    duration=Duration.MONTHLY,
                )
            )
            await session.commit()

        async with session_factory() as session:
            assert await effective_plan(session, user_id) == Plan.PREMIUM
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()
