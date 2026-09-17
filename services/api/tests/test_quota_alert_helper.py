"""`py_db.quotas.maybe_record_quota_alert` — issue #142's idempotent
threshold-crossing insert. Covers the crossing-detection logic exhaustively
here (mirrors test_effective_quota_helper.py's style for its own seam); each
HTTP call site's own test only needs one thin case confirming it fires.
"""

import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import Plan, Quotaalertthreshold, Quotakind, QuotaAlert, User
from py_db.quotas import maybe_record_quota_alert
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_crossing_80_percent_inserts_an_approaching_alert():
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
            # cap=10: used_after=8 is the first unit to cross 80%
            # (used_before=7 was still below it).
            await maybe_record_quota_alert(
                session, user_id, Quotakind.ANALYSES_DAILY, cap=10, used_after=8
            )
            await session.commit()

        async with session_factory() as session:
            rows = (
                await session.scalars(select(QuotaAlert).where(QuotaAlert.userId == user_id))
            ).all()
            assert len(rows) == 1
            assert rows[0].threshold == Quotaalertthreshold.APPROACHING
            assert rows[0].quotaKind == Quotakind.ANALYSES_DAILY
    finally:
        async with session_factory() as session:
            await session.execute(delete(QuotaAlert).where(QuotaAlert.userId == user_id))
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_reaching_100_percent_inserts_an_exceeded_alert():
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
            await maybe_record_quota_alert(
                session, user_id, Quotakind.ANALYSES_DAILY, cap=10, used_after=10
            )
            await session.commit()

        async with session_factory() as session:
            rows = (
                await session.scalars(select(QuotaAlert).where(QuotaAlert.userId == user_id))
            ).all()
            assert len(rows) == 1
            assert rows[0].threshold == Quotaalertthreshold.EXCEEDED
    finally:
        async with session_factory() as session:
            await session.execute(delete(QuotaAlert).where(QuotaAlert.userId == user_id))
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_staying_over_the_limit_does_not_re_fire_on_every_call():
    """Repeated calls with used_after already past the threshold (e.g. two
    quota-consuming actions in a row while already over) must not each insert
    their own row — only the crossing itself does.
    """
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
            # used_after=10 and used_after=11 both resolve to EXCEEDED - only
            # the first (the actual crossing) should insert a row.
            await maybe_record_quota_alert(
                session, user_id, Quotakind.ANALYSES_DAILY, cap=10, used_after=10
            )
            await session.commit()

        async with session_factory() as session:
            await maybe_record_quota_alert(
                session, user_id, Quotakind.ANALYSES_DAILY, cap=10, used_after=11
            )
            await session.commit()

        async with session_factory() as session:
            rows = (
                await session.scalars(select(QuotaAlert).where(QuotaAlert.userId == user_id))
            ).all()
            assert len(rows) == 1
    finally:
        async with session_factory() as session:
            await session.execute(delete(QuotaAlert).where(QuotaAlert.userId == user_id))
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_unlimited_cap_never_inserts_an_alert():
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
            await maybe_record_quota_alert(
                session, user_id, Quotakind.ANALYSES_DAILY, cap=None, used_after=1000
            )
            await session.commit()

        async with session_factory() as session:
            rows = (
                await session.scalars(select(QuotaAlert).where(QuotaAlert.userId == user_id))
            ).all()
            assert rows == []
    finally:
        async with session_factory() as session:
            await session.execute(delete(QuotaAlert).where(QuotaAlert.userId == user_id))
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
        await engine.dispose()
