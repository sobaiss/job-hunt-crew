"""Daily autonomous scheduling (issue #57).

Pure "due?" predicate (`py_db.scout_schedule`) pinned directly; `due_scouts` /
`run_scheduler_tick` (`scout.schedule`) exercised against a real session,
mirroring `test_dispatch_scout_run.py`.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from py_db.models import CVVersion, Cvfiletype, Cvconversionstatus, Scout, ScoutRun, Scoutrunstatus, Scoutstatus, User
from py_db.scout_schedule import (
    DEFAULT_SCOUT_RUN_STUCK_AFTER_MINUTES,
    DEFAULT_SCOUT_SCHEDULE_HOUR_UTC,
    is_scout_due,
    is_scout_run_stale,
    scout_run_stuck_after,
    scout_schedule_hour_utc,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from scout.schedule import due_scouts, run_scheduler_tick

# --- scout_schedule_hour_utc -------------------------------------------------


def test_scout_schedule_hour_defaults_when_unset(monkeypatch):
    monkeypatch.delenv("SCOUT_SCHEDULE_HOUR_UTC", raising=False)
    assert scout_schedule_hour_utc() == DEFAULT_SCOUT_SCHEDULE_HOUR_UTC


def test_scout_schedule_hour_reads_env(monkeypatch):
    monkeypatch.setenv("SCOUT_SCHEDULE_HOUR_UTC", "14")
    assert scout_schedule_hour_utc() == 14


def test_scout_schedule_hour_falls_back_when_out_of_range_or_invalid(monkeypatch):
    monkeypatch.setenv("SCOUT_SCHEDULE_HOUR_UTC", "24")
    assert scout_schedule_hour_utc() == DEFAULT_SCOUT_SCHEDULE_HOUR_UTC
    monkeypatch.setenv("SCOUT_SCHEDULE_HOUR_UTC", "not-a-number")
    assert scout_schedule_hour_utc() == DEFAULT_SCOUT_SCHEDULE_HOUR_UTC


# --- is_scout_due -------------------------------------------------------------


def test_not_due_before_todays_scheduled_hour():
    now = datetime(2026, 9, 11, 5, 0)  # scheduled hour 6, not there yet
    assert is_scout_due(Scoutstatus.ACTIVE, None, now, schedule_hour=6) is False


def test_due_past_scheduled_hour_with_no_prior_run():
    now = datetime(2026, 9, 11, 6, 30)
    assert is_scout_due(Scoutstatus.ACTIVE, None, now, schedule_hour=6) is True


def test_due_when_last_run_was_before_todays_hour():
    now = datetime(2026, 9, 11, 7, 0)
    last_run = datetime(2026, 9, 10, 8, 0)  # yesterday, after yesterday's hour
    assert is_scout_due(Scoutstatus.ACTIVE, last_run, now, schedule_hour=6) is True


def test_not_due_again_once_it_already_ran_past_todays_hour():
    now = datetime(2026, 9, 11, 7, 0)
    last_run = datetime(2026, 9, 11, 6, 15)  # already ran today, after the hour
    assert is_scout_due(Scoutstatus.ACTIVE, last_run, now, schedule_hour=6) is False


def test_no_backfill_a_multi_day_gap_runs_once_not_repeatedly():
    now = datetime(2026, 9, 11, 9, 0)
    last_run = datetime(2026, 9, 5, 6, 30)  # missed several days
    assert is_scout_due(Scoutstatus.ACTIVE, last_run, now, schedule_hour=6) is True
    # ...and the predicate itself has no notion of "how many days" — a single
    # call answers only "due right now", which is what run_scheduler_tick acts on.


def test_paused_and_archived_scouts_are_never_due():
    now = datetime(2026, 9, 11, 9, 0)
    assert is_scout_due(Scoutstatus.PAUSED, None, now, schedule_hour=6) is False
    assert is_scout_due(Scoutstatus.ARCHIVED, None, now, schedule_hour=6) is False


# --- due_scouts / run_scheduler_tick (DB-backed) ------------------------------


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class FakeSqs:
    def __init__(self):
        self.messages: list[tuple[str, dict]] = []

    def send_message(self, *, QueueUrl, MessageBody):
        self.messages.append((QueueUrl, json.loads(MessageBody)))


async def _make_scout(session, *, status=Scoutstatus.ACTIVE, last_run_at=None):
    user_id = f"sched-test-user-{uuid.uuid4()}"
    cv_id = f"sched-test-cv-{uuid.uuid4()}"
    scout_id = f"sched-test-{uuid.uuid4()}"
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
            targetSiteKeys=["FRANCE_TRAVAIL"],
            filters={},
            matchThreshold=70,
            status=status,
            lastRunAt=last_run_at,
            updatedAt=_now(),
        )
    )
    await session.commit()
    return user_id, cv_id, scout_id


async def _cleanup(session_factory, *, user_id, scout_id):
    async with session_factory() as session:
        runs = (await session.scalars(select(ScoutRun).where(ScoutRun.scoutId == scout_id))).all()
        for run in runs:
            await session.delete(run)
        await session.commit()
        scout = await session.get(Scout, scout_id)
        if scout is not None:
            await session.delete(scout)
        await session.commit()
        for cv in (await session.scalars(select(CVVersion).where(CVVersion.userId == user_id))).all():
            await session.delete(cv)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


@pytest.mark.asyncio
async def test_due_scouts_selects_only_active_and_due():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    now = datetime(2026, 9, 11, 7, 0)
    async with session_factory() as session:
        active_user_id, _, due_id = await _make_scout(
            session, status=Scoutstatus.ACTIVE, last_run_at=None
        )
        paused_user_id, _, paused_id = await _make_scout(
            session, status=Scoutstatus.PAUSED, last_run_at=None
        )
    try:
        async with session_factory() as session:
            due = await due_scouts(session, now=now)
        due_ids = {s.id for s in due}
        assert due_id in due_ids
        assert paused_id not in due_ids
    finally:
        await _cleanup(session_factory, user_id=active_user_id, scout_id=due_id)
        await _cleanup(session_factory, user_id=paused_user_id, scout_id=paused_id)
        await engine.dispose()


async def _scout_run_ids(session_factory, scout_id: str) -> set[str]:
    async with session_factory() as session:
        rows = (await session.scalars(select(ScoutRun.id).where(ScoutRun.scoutId == scout_id))).all()
    return set(rows)


@pytest.mark.asyncio
async def test_run_scheduler_tick_creates_a_run_and_enqueues_for_each_due_scout():
    # Scoped to this test's own scout throughout: `due_scouts` scans the whole
    # `Scout` table by design (production has one shared schedule tick for
    # every user), so a shared dev/test Postgres can carry other ACTIVE Scout
    # rows (e.g. left over from manual UI testing) that would also be due and
    # inflate `run_ids`/`fake_sqs.messages` — asserting global counts here is
    # what made this test flaky, not the scheduler logic itself.
    engine = make_engine()
    session_factory = make_session_factory(engine)
    now = datetime(2026, 9, 11, 7, 0)
    async with session_factory() as session:
        user_id, cv_id, scout_id = await _make_scout(session, status=Scoutstatus.ACTIVE, last_run_at=None)
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run_ids = await run_scheduler_tick(session, sqs_client=fake_sqs, now=now)

        this_scout_runs = await _scout_run_ids(session_factory, scout_id)
        assert len(this_scout_runs) == 1
        (this_run_id,) = this_scout_runs
        assert this_run_id in run_ids
        async with session_factory() as session:
            run = await session.get(ScoutRun, this_run_id)
        assert run is not None
        assert run.status == Scoutrunstatus.PENDING
        matching_messages = [body for _, body in fake_sqs.messages if body == {"scoutRunId": this_run_id}]
        assert len(matching_messages) == 1
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_scheduler_tick_skips_a_scout_with_a_running_run():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    now = datetime(2026, 9, 11, 7, 0)
    async with session_factory() as session:
        user_id, cv_id, scout_id = await _make_scout(session, status=Scoutstatus.ACTIVE, last_run_at=None)
        running_run_id = f"run-{uuid.uuid4()}"
        session.add(ScoutRun(id=running_run_id, scoutId=scout_id, status=Scoutrunstatus.RUNNING))
        await session.commit()
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run_ids = await run_scheduler_tick(session, sqs_client=fake_sqs, now=now)

        assert running_run_id not in run_ids
        this_scout_runs = await _scout_run_ids(session_factory, scout_id)
        assert this_scout_runs == {running_run_id}
        assert not any(body.get("scoutRunId") == running_run_id for _, body in fake_sqs.messages)
        assert not any(body.get("scoutRunId") in this_scout_runs - {running_run_id} for _, body in fake_sqs.messages)
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_scheduler_tick_does_not_re_enqueue_a_scout_that_already_ran_today():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    now = datetime(2026, 9, 11, 7, 0)
    already_ran = datetime(2026, 9, 11, 6, 15)
    async with session_factory() as session:
        user_id, cv_id, scout_id = await _make_scout(
            session, status=Scoutstatus.ACTIVE, last_run_at=already_ran
        )
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run_ids = await run_scheduler_tick(session, sqs_client=fake_sqs, now=now)

        this_scout_runs = await _scout_run_ids(session_factory, scout_id)
        assert this_scout_runs == set()
        assert not (this_scout_runs & set(run_ids))
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


# --- is_scout_run_stale (docs/adr/0032) ---------------------------------------
# A ScoutRun is only RUNNING while `dispatch_scout_run` fans out — DB writes and
# SQS sends, no LLM — so a RUNNING run older than the threshold was abandoned by
# a dead worker. It matters because both skip-on-overlap guards would otherwise
# honour it forever and silence the Scout's schedule for good (docs/adr/0004).

STALE_NOW = datetime(2026, 9, 11, 7, 0)


def test_a_fresh_running_run_is_not_stale():
    started = STALE_NOW - timedelta(minutes=5)
    assert is_scout_run_stale(Scoutrunstatus.RUNNING, started, started, now=STALE_NOW) is False


def test_a_long_running_run_is_stale():
    started = STALE_NOW - timedelta(hours=2)
    assert is_scout_run_stale(Scoutrunstatus.RUNNING, started, started, now=STALE_NOW) is True


def test_created_at_is_the_fallback_clock():
    """`startedAt` is stamped in the same commit as RUNNING, so it is normally
    set; a row that somehow lacks it must still be recoverable."""
    created = STALE_NOW - timedelta(hours=2)
    assert is_scout_run_stale(Scoutrunstatus.RUNNING, None, created, now=STALE_NOW) is True


@pytest.mark.parametrize(
    "status",
    [
        Scoutrunstatus.PENDING,
        Scoutrunstatus.COMPLETED,
        Scoutrunstatus.PARTIALLY_COMPLETED,
        Scoutrunstatus.FAILED,
    ],
)
def test_only_a_running_run_can_go_stale(status):
    """PENDING in particular: it holds no overlap lock over the Scout, so an old
    undispatched run is left alone rather than failed."""
    old = STALE_NOW - timedelta(days=3)
    assert is_scout_run_stale(status, old, old, now=STALE_NOW) is False


def test_scout_run_stuck_after_reads_env(monkeypatch):
    monkeypatch.setenv("SCOUT_RUN_STUCK_AFTER_MINUTES", "45")
    assert scout_run_stuck_after() == timedelta(minutes=45)
    monkeypatch.setenv("SCOUT_RUN_STUCK_AFTER_MINUTES", "not-a-number")
    assert scout_run_stuck_after() == timedelta(minutes=DEFAULT_SCOUT_RUN_STUCK_AFTER_MINUTES)
    monkeypatch.setenv("SCOUT_RUN_STUCK_AFTER_MINUTES", "0")
    assert scout_run_stuck_after() == timedelta(minutes=DEFAULT_SCOUT_RUN_STUCK_AFTER_MINUTES)


@pytest.mark.asyncio
async def test_run_scheduler_tick_closes_an_abandoned_run_and_enqueues_the_scout():
    """The recovery the user's incident needs: a worker killed mid-fan-out left a
    RUNNING run behind, which without this would block the Scout permanently.
    The run is closed FAILED and the Scout runs again on the same tick."""
    engine = make_engine()
    session_factory = make_session_factory(engine)
    now = datetime(2026, 9, 11, 7, 0)
    async with session_factory() as session:
        user_id, cv_id, scout_id = await _make_scout(
            session, status=Scoutstatus.ACTIVE, last_run_at=None
        )
        abandoned_run_id = f"run-{uuid.uuid4()}"
        session.add(
            ScoutRun(
                id=abandoned_run_id,
                scoutId=scout_id,
                status=Scoutrunstatus.RUNNING,
                startedAt=now - timedelta(hours=2),
            )
        )
        await session.commit()
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run_ids = await run_scheduler_tick(session, sqs_client=fake_sqs, now=now)

        assert len(run_ids) == 1, "the Scout is no longer blocked"
        assert abandoned_run_id not in run_ids
        assert any(body.get("scoutRunId") == run_ids[0] for _, body in fake_sqs.messages)

        async with session_factory() as session:
            abandoned = await session.get(ScoutRun, abandoned_run_id)
            assert abandoned.status == Scoutrunstatus.FAILED
            assert abandoned.finishedAt == now
            assert "interrupted" in abandoned.errorMessage
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_scheduler_tick_still_honours_a_genuinely_running_run():
    """The guard is not weakened: a run that started moments ago still blocks the
    Scout, and is left untouched."""
    engine = make_engine()
    session_factory = make_session_factory(engine)
    now = datetime(2026, 9, 11, 7, 0)
    async with session_factory() as session:
        user_id, cv_id, scout_id = await _make_scout(
            session, status=Scoutstatus.ACTIVE, last_run_at=None
        )
        live_run_id = f"run-{uuid.uuid4()}"
        session.add(
            ScoutRun(
                id=live_run_id,
                scoutId=scout_id,
                status=Scoutrunstatus.RUNNING,
                startedAt=now - timedelta(minutes=2),
            )
        )
        await session.commit()
    fake_sqs = FakeSqs()
    try:
        async with session_factory() as session:
            run_ids = await run_scheduler_tick(session, sqs_client=fake_sqs, now=now)

        assert run_ids == []
        assert fake_sqs.messages == []

        async with session_factory() as session:
            live = await session.get(ScoutRun, live_run_id)
            assert live.status == Scoutrunstatus.RUNNING
            assert live.errorMessage is None
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()
