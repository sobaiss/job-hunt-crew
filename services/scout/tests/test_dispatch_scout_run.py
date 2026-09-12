import json
import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import (
    CVVersion,
    Cvconversionstatus,
    Cvfiletype,
    IngestionJob,
    Ingestionmode,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    SiteConfig,
    Siteconfigsitekey,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from scout import intake_handler
from scout.dispatch import ScoutRunError, dispatch_scout_run

INGESTION_QUEUE = "http://localhost:9324/000000000000/ingestion-intake"


class FakeSqs:
    def __init__(self):
        self.messages: list[tuple[str, dict]] = []

    def send_message(self, *, QueueUrl, MessageBody):
        self.messages.append((QueueUrl, json.loads(MessageBody)))


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


async def _seed(
    session_factory,
    *,
    target_site_keys,
    scout_status=Scoutstatus.ACTIVE,
    extra_runs=(),
):
    user_id = f"scout-test-user-{uuid.uuid4()}"
    cv_id = f"scout-test-cv-{uuid.uuid4()}"
    scout_id = f"scout-test-{uuid.uuid4()}"
    run_id = f"scout-run-{uuid.uuid4()}"
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            CVVersion(
                id=cv_id,
                userId=user_id,
                label="CV",
                fileKey="cv/x.pdf",
                fileName="x.pdf",
                fileType=Cvfiletype.PDF,
                fileSizeBytes=1234,
                conversionStatus=Cvconversionstatus.CONVERTED,
                markdownContent="# CV",
                updatedAt=_now(),
            )
        )
        session.add(
            Scout(
                id=scout_id,
                userId=user_id,
                label="Test Scout",
                cvVersionId=cv_id,
                targetSiteKeys=list(target_site_keys),
                filters={"keywords": "python", "postedWithin": "7d"},
                matchThreshold=70,
                status=scout_status,
                updatedAt=_now(),
            )
        )
        session.add(ScoutRun(id=run_id, scoutId=scout_id, status=Scoutrunstatus.PENDING))
        for status in extra_runs:
            session.add(
                ScoutRun(id=f"scout-run-{uuid.uuid4()}", scoutId=scout_id, status=status)
            )
        await session.commit()
    return user_id, cv_id, scout_id, run_id


async def _cleanup(session_factory, *, user_id, scout_id):
    async with session_factory() as session:
        runs = (
            await session.scalars(select(ScoutRun).where(ScoutRun.scoutId == scout_id))
        ).all()
        for run in runs:
            for job in (
                await session.scalars(
                    select(IngestionJob).where(IngestionJob.scoutRunId == run.id)
                )
            ).all():
                await session.delete(job)
        await session.commit()
        for run in runs:
            await session.delete(await session.get(ScoutRun, run.id))
        scout = await session.get(Scout, scout_id)
        if scout is not None:
            await session.delete(scout)
        await session.commit()
        for cv in (
            await session.scalars(select(CVVersion).where(CVVersion.userId == user_id))
        ).all():
            await session.delete(cv)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


async def _set_site_enabled(session_factory, site_key: Siteconfigsitekey, enabled: bool) -> bool:
    async with session_factory() as session:
        row = (
            await session.scalars(select(SiteConfig).where(SiteConfig.siteKey == site_key))
        ).first()
        if row is None:
            return False
        previous = row.enabled
        row.enabled = enabled
        row.updatedAt = _now()
        await session.commit()
        return previous


@pytest.mark.asyncio
async def test_dispatch_creates_one_ingestion_job_per_enabled_site_and_enqueues():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_id, scout_id, run_id = await _seed(
        session_factory, target_site_keys=["FRANCE_TRAVAIL", "LINKEDIN"]
    )
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run = await dispatch_scout_run(session, run_id, sqs_client=fake_sqs)

        assert run.status == Scoutrunstatus.COMPLETED
        assert run.sitesQueried == 2
        assert run.siteUnavailableCount == 0
        assert run.startedAt is not None and run.finishedAt is not None

        async with session_factory() as session:
            jobs = (
                await session.scalars(
                    select(IngestionJob).where(IngestionJob.scoutRunId == run_id)
                )
            ).all()
            scout = await session.get(Scout, scout_id)
        assert len(jobs) == 2
        assert {j.mode for j in jobs} == {Ingestionmode.SITE_SEARCH}
        assert all(j.cvVersionId == cv_id for j in jobs)
        assert all(j.filters == {"keywords": "python", "postedWithin": "7d"} for j in jobs)
        assert scout.lastRunAt is not None

        assert [m[0] for m in fake_sqs.messages] == [INGESTION_QUEUE, INGESTION_QUEUE]
        assert {m[1]["ingestionJobId"] for m in fake_sqs.messages} == {j.id for j in jobs}
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_counts_disabled_site_as_unavailable_without_failing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    previous = await _set_site_enabled(session_factory, Siteconfigsitekey.GLASSDOOR, False)
    user_id, cv_id, scout_id, run_id = await _seed(
        session_factory, target_site_keys=["FRANCE_TRAVAIL", "GLASSDOOR"]
    )
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run = await dispatch_scout_run(session, run_id, sqs_client=fake_sqs)

        assert run.status == Scoutrunstatus.PARTIALLY_COMPLETED
        assert run.sitesQueried == 1
        assert run.siteUnavailableCount == 1
        assert len(fake_sqs.messages) == 1
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await _set_site_enabled(session_factory, Siteconfigsitekey.GLASSDOOR, previous)
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_fails_when_every_targeted_site_is_unavailable():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    previous = await _set_site_enabled(session_factory, Siteconfigsitekey.GLASSDOOR, False)
    user_id, cv_id, scout_id, run_id = await _seed(
        session_factory, target_site_keys=["GLASSDOOR"]
    )
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run = await dispatch_scout_run(session, run_id, sqs_client=fake_sqs)

        assert run.status == Scoutrunstatus.FAILED
        assert run.errorMessage
        assert run.sitesQueried == 0
        assert fake_sqs.messages == []
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await _set_site_enabled(session_factory, Siteconfigsitekey.GLASSDOOR, previous)
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_non_active_scout_is_failed_and_creates_nothing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_id, scout_id, run_id = await _seed(
        session_factory, target_site_keys=["FRANCE_TRAVAIL"], scout_status=Scoutstatus.PAUSED
    )
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run = await dispatch_scout_run(session, run_id, sqs_client=fake_sqs)

        assert run.status == Scoutrunstatus.FAILED
        assert "PAUSED" in run.errorMessage
        assert fake_sqs.messages == []

        async with session_factory() as session:
            jobs = (
                await session.scalars(
                    select(IngestionJob).where(IngestionJob.scoutRunId == run_id)
                )
            ).all()
        assert jobs == []
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_skips_when_a_previous_run_is_still_running():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_id, scout_id, run_id = await _seed(
        session_factory,
        target_site_keys=["FRANCE_TRAVAIL"],
        extra_runs=[Scoutrunstatus.RUNNING],
    )
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run = await dispatch_scout_run(session, run_id, sqs_client=fake_sqs)

        assert run.status == Scoutrunstatus.PENDING
        assert fake_sqs.messages == []
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_missing_run_raises():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            with pytest.raises(ScoutRunError):
                await dispatch_scout_run(session, f"missing-{uuid.uuid4()}")
    finally:
        await engine.dispose()


def test_handle_scout_intake_unwraps_records_and_dispatches(monkeypatch):
    seen = []

    async def _spy(session, scout_run_id, **kwargs):
        seen.append(scout_run_id)

    monkeypatch.setattr(intake_handler, "dispatch_scout_run", _spy)

    event = {
        "Records": [
            {"body": json.dumps({"scoutRunId": "run-1"})},
            {"body": json.dumps({"scoutRunId": "run-2"})},
        ]
    }
    intake_handler.handle_scout_intake(event)

    assert seen == ["run-1", "run-2"]
