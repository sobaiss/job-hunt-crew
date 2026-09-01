"""The shared per-user daily-analysis-cap helper (`py_db.quota`), extracted in
issue #33 so `POST /v1/analyses` and the ingestion fan-out enforce one
identical rule. The HTTP-level behaviour of `POST /v1/analyses` is covered by
`test_v1_analyses.py`; this file pins the helper itself.
"""

import uuid
from datetime import UTC, datetime

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
from py_db.quota import (
    DEFAULT_DAILY_ANALYSIS_CAP,
    analyses_requested_today,
    daily_analysis_cap,
    remaining_daily_analyses,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def test_cap_defaults_to_50_when_unset(monkeypatch):
    monkeypatch.delenv("DAILY_ANALYSIS_CAP", raising=False)
    assert daily_analysis_cap() == DEFAULT_DAILY_ANALYSIS_CAP == 50


def test_cap_reads_a_valid_positive_int(monkeypatch):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "7")
    assert daily_analysis_cap() == 7


@pytest.mark.parametrize("bad", ["", "nope", "0", "-3", "3.5"])
def test_cap_falls_back_on_non_positive_or_non_numeric(monkeypatch, bad):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", bad)
    assert daily_analysis_cap() == DEFAULT_DAILY_ANALYSIS_CAP


@pytest.mark.asyncio
async def test_count_and_remaining_are_scoped_to_the_user(monkeypatch):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "5")
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
            assert await remaining_daily_analyses(session, user_id) == 2
            assert await analyses_requested_today(session, other_user_id) == 1
    finally:
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id.in_([user_id, other_user_id])))
            await session.execute(delete(JobOffer).where(JobOffer.id.in_(offer_ids)))
            await session.commit()
        await engine.dispose()
