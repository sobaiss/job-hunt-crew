"""The stuck-Analysis predicate (`py_db.stuck_analysis`), the rule that decides
whether the Web offers "Relancer l'analyse" and whether
`POST /v1/analyses/{id}/requeue` accepts (docs/adr/0032). The HTTP-level
behaviour of that endpoint is covered by `test_v1_analyses.py`; this file pins
the predicate itself, including the backlog case that makes it more than an age
check.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from py_db.models import Analysisstatus, PipelineEvent
from py_db.session import make_engine, make_session_factory
from py_db.stuck_analysis import is_analysis_stuck, latest_pipeline_activity
from sqlalchemy import delete

NOW = datetime(2026, 9, 24, 12, 0, 0)
STUCK_AFTER = timedelta(minutes=20)
IDLE_GRACE = timedelta(minutes=15)

LONG_AGO = NOW - timedelta(hours=3)
JUST_NOW = NOW - timedelta(minutes=1)


def _milliseconds(value: datetime) -> datetime:
    """`PipelineEvent.createdAt` is `TIMESTAMP(3)` (Prisma's `DateTime`), so a
    microsecond-precision value does not survive the round trip. Truncating up
    front keeps the equality assertions below exact.
    """
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def _stuck(
    status: Analysisstatus,
    *,
    requested_at: datetime = LONG_AGO,
    requeued_at: datetime | None = None,
    started_at: datetime | None = None,
    last_pipeline_activity: datetime | None = None,
) -> bool:
    return is_analysis_stuck(
        status,
        requested_at,
        requeued_at,
        started_at,
        now=NOW,
        last_pipeline_activity=last_pipeline_activity,
        stuck_after=STUCK_AFTER,
        idle_grace=IDLE_GRACE,
    )


@pytest.mark.parametrize("status", [Analysisstatus.COMPLETED, Analysisstatus.FAILED])
def test_a_terminal_analysis_is_never_stuck(status):
    """However old, and however dead the pipeline: re-running one of these is
    the separate, quota-charged `POST /v1/analyses` of docs/adr/0011."""
    assert _stuck(status, started_at=LONG_AGO) is False


def test_an_abandoned_in_flight_analysis_is_stuck():
    """`startedAt` set means a worker was inside this row, so nothing is queued
    behind it — an overdue clock can only mean the process died. True even while
    the pipeline is otherwise busy, since that work is not this row's."""
    assert _stuck(
        Analysisstatus.RUNNING_CREW,
        started_at=LONG_AGO,
        last_pipeline_activity=JUST_NOW,
    )


def test_a_queued_analysis_is_not_stuck_while_the_pipeline_advances():
    """The case a plain age check gets wrong. A Scout fans out up to 25 offers
    *per site* and the local worker drains them one at a time, so the tail of a
    multi-site run legitimately waits hours at PENDING. A recent PipelineEvent
    proves the chain is still moving, so this row is waiting, not lost.
    """
    assert (
        _stuck(
            Analysisstatus.PENDING,
            requested_at=LONG_AGO,
            last_pipeline_activity=JUST_NOW,
        )
        is False
    )


def test_a_queued_analysis_is_stuck_once_the_pipeline_goes_quiet():
    """The user's incident: the queue was dropped by a restart, so no worker is
    coming for this row and nothing anywhere is writing events."""
    assert _stuck(
        Analysisstatus.PENDING,
        requested_at=LONG_AGO,
        last_pipeline_activity=NOW - timedelta(hours=1),
    )


def test_a_queued_analysis_is_stuck_when_the_trail_is_empty():
    """No PipelineEvent has ever been written — a fresh install whose worker
    never ran. Absence of a trail is not evidence of liveness."""
    assert _stuck(Analysisstatus.PENDING, requested_at=LONG_AGO, last_pipeline_activity=None)


@pytest.mark.parametrize(
    "status",
    [
        Analysisstatus.PENDING,
        Analysisstatus.QUEUED,
        Analysisstatus.RUNNING_CREW,
        Analysisstatus.AWAITING_RESULT,
        Analysisstatus.PERSISTING,
    ],
)
def test_a_recent_analysis_is_never_stuck(status):
    """Inside the threshold nothing is declared dead, whatever the status and
    however quiet the pipeline — an analysis is allowed to take its time."""
    assert (
        _stuck(status, requested_at=JUST_NOW, started_at=JUST_NOW, last_pipeline_activity=None)
        is False
    )


def test_the_clock_is_the_latest_of_the_three_timestamps():
    """A requeue restarts the staleness clock, which is what stops the button
    inviting a second click straight away."""
    assert _stuck(
        Analysisstatus.PENDING, requested_at=LONG_AGO, requeued_at=LONG_AGO
    ), "an old requeue leaves the row stuck"
    assert (
        _stuck(Analysisstatus.PENDING, requested_at=LONG_AGO, requeued_at=JUST_NOW) is False
    ), "a fresh requeue restarts the clock"
    assert (
        _stuck(Analysisstatus.PENDING, requested_at=LONG_AGO, started_at=JUST_NOW) is False
    ), "a fresh crew start restarts the clock"


def test_the_grace_boundary_is_inclusive():
    """Exactly at `idle_grace` the pipeline still counts as alive, so a queued
    row is spared. Pins the comparison so a later `<` vs `<=` edit is a visible
    behaviour change."""
    assert (
        _stuck(
            Analysisstatus.PENDING,
            requested_at=LONG_AGO,
            last_pipeline_activity=NOW - IDLE_GRACE,
        )
        is False
    )


@pytest.mark.asyncio
async def test_latest_pipeline_activity_is_the_max_over_the_whole_trail():
    """The liveness probe is global on purpose: it answers "is anything moving?",
    so events belonging to other analyses (or to none) count too.

    Asserted as a relationship against whatever the trail already holds rather
    than an absolute timestamp — other suites write events to this same database,
    so a fixed expected value would be order-dependent.
    """
    engine = make_engine()
    session_factory = make_session_factory(engine)
    event_ids: list[str] = []

    try:
        async with session_factory() as session:
            baseline = await latest_pipeline_activity(session)
            anchor = _milliseconds(baseline or datetime.now(UTC).replace(tzinfo=None))

            older = PipelineEvent(
                id=str(uuid.uuid4()),
                stage="crew",
                status="STARTED",
                createdAt=anchor - timedelta(hours=2),
            )
            event_ids.append(older.id)
            session.add(older)
            await session.commit()
            assert await latest_pipeline_activity(session) == (baseline or older.createdAt), (
                "an older event must not lower the max"
            )

            newest = PipelineEvent(
                id=str(uuid.uuid4()),
                stage="persist",
                status="SUCCEEDED",
                createdAt=anchor + timedelta(hours=1),
            )
            event_ids.append(newest.id)
            session.add(newest)
            await session.commit()
            assert await latest_pipeline_activity(session) == newest.createdAt, (
                "a newer event must raise the max"
            )
    finally:
        async with session_factory() as session:
            await session.execute(delete(PipelineEvent).where(PipelineEvent.id.in_(event_ids)))
            await session.commit()
        await engine.dispose()
