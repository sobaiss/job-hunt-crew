"""The shared Analysis usage counters (`py_db.quota.analyses_requested_today`
/ `analyses_requested_this_month`), extracted in issue #33 (daily) and
extended in issue #136 (monthly) so `POST /v1/analyses` and the ingestion
fan-out enforce identical ANALYSES_DAILY/ANALYSES_MONTHLY ceilings via
`py_db.quotas.effective_quota`. The HTTP-level behaviour of `POST
/v1/analyses` is covered by `test_v1_analyses.py`; the ceiling-resolution
precedence itself is covered by `test_effective_quota_helper.py`; this file
pins the two usage counters.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    JobOffer,
    Joboffersourcesite,
    User,
)
from py_db.quota import analyses_requested_this_month, analyses_requested_today
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest.mark.asyncio
async def test_counters_are_scoped_to_the_user():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    other_user_id = str(uuid.uuid4())
    offer_ids: list[str] = []

    try:
        async with session_factory() as session:
            for uid in (user_id, other_user_id):
                session.add(User(id=uid, email=f"{uid}@example.com", updatedAt=_now()))
            cv_id = str(uuid.uuid4())
            session.add(
                CVVersion(
                    id=cv_id,
                    userId=user_id,
                    label="CV",
                    fileKey="cv/x.pdf",
                    fileName="x.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=10,
                    updatedAt=_now(),
                )
            )
            other_cv_id = str(uuid.uuid4())
            session.add(
                CVVersion(
                    id=other_cv_id,
                    userId=other_user_id,
                    label="CV",
                    fileKey="cv/y.pdf",
                    fileName="y.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=10,
                    updatedAt=_now(),
                )
            )
            # 3 analyses today for user_id, 1 today for other_user_id.
            for owner, cv in ((user_id, cv_id), (user_id, cv_id), (user_id, cv_id), (other_user_id, other_cv_id)):
                offer_id = str(uuid.uuid4())
                offer_ids.append(offer_id)
                session.add(
                    JobOffer(
                        id=offer_id,
                        sourceUrl=f"https://example.com/jobs/{offer_id}",
                        sourceSite=Joboffersourcesite.OTHER,
                        updatedAt=_now(),
                    )
                )
                session.add(
                    Analysis(
                        id=str(uuid.uuid4()),
                        userId=owner,
                        jobOfferId=offer_id,
                        cvVersionId=cv,
                        status=Analysisstatus.PENDING,
                    )
                )
            await session.commit()

        async with session_factory() as session:
            assert await analyses_requested_today(session, user_id) == 3
            assert await analyses_requested_today(session, other_user_id) == 1
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id.in_([user_id, other_user_id])))
            await session.execute(delete(JobOffer).where(JobOffer.id.in_(offer_ids)))
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_monthly_counter_includes_earlier_this_month_but_not_last_month():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = str(uuid.uuid4())
    offer_ids: list[str] = []

    start_of_month = _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    earlier_this_month = start_of_month + timedelta(hours=1)
    last_month = start_of_month - timedelta(days=1)

    try:
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            cv_id = str(uuid.uuid4())
            session.add(
                CVVersion(
                    id=cv_id,
                    userId=user_id,
                    label="CV",
                    fileKey="cv/x.pdf",
                    fileName="x.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=10,
                    updatedAt=_now(),
                )
            )
            # One Analysis requested earlier this month, one requested last
            # month — only the former should count towards this month's total.
            for requested_at in (earlier_this_month, last_month):
                offer_id = str(uuid.uuid4())
                offer_ids.append(offer_id)
                session.add(
                    JobOffer(
                        id=offer_id,
                        sourceUrl=f"https://example.com/jobs/{offer_id}",
                        sourceSite=Joboffersourcesite.OTHER,
                        updatedAt=_now(),
                    )
                )
                session.add(
                    Analysis(
                        id=str(uuid.uuid4()),
                        userId=user_id,
                        jobOfferId=offer_id,
                        cvVersionId=cv_id,
                        status=Analysisstatus.PENDING,
                        requestedAt=requested_at,
                    )
                )
            await session.commit()

        async with session_factory() as session:
            assert await analyses_requested_this_month(session, user_id) == 1
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.execute(delete(JobOffer).where(JobOffer.id.in_(offer_ids)))
            await session.commit()
        await engine.dispose()
