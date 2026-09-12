"""Daily autonomous scheduling (issue #57).

Production target architecture: one EventBridge Scheduler rule fires at
`SCOUT_SCHEDULE_HOUR_UTC` and its target enqueues one `scout-intake` message
per due Scout directly — no polling loop. Real IaC for that rule is out of
scope per the PRD (see `services/scout` docs); this module is the target's
logic, callable from anywhere that can reach Postgres + SQS.

Locally, `ingestion.local_worker.run_forever` calls `run_scheduler_tick_once`
on a fixed interval as a stand-in for the EventBridge rule. Either caller
gets the same result: a `PENDING` `ScoutRun` + `scout-intake` enqueue per due
Scout, the exact shape `POST /v1/scouts/{id}/run` (services/api) already
produces for a manual "Run now" — `dispatch_scout_run` (this package) does
the rest, including its own skip-on-overlap check.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime

from py_db.models import Scout, ScoutRun, Scoutrunstatus, Scoutstatus
from py_db.scout_schedule import is_scout_due
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .sqs_client import SCOUT_INTAKE_QUEUE_URL, make_sqs_client

logger = get_logger(__name__)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _has_running_run(session: AsyncSession, scout_id: str) -> bool:
    stmt = select(ScoutRun.id).where(
        ScoutRun.scoutId == scout_id, ScoutRun.status == Scoutrunstatus.RUNNING
    )
    return (await session.scalars(stmt)).first() is not None


async def due_scouts(session: AsyncSession, *, now: datetime | None = None) -> list[Scout]:
    """Active Scouts due for their daily run (`is_scout_due`), excluding any
    whose latest run is still `RUNNING` (skip-on-overlap) — a Scout mid-run
    from a manual "Run now" or an earlier tick is not enqueued again.
    """
    now = now or _now()
    candidates = (
        await session.scalars(select(Scout).where(Scout.status == Scoutstatus.ACTIVE))
    ).all()
    due = [s for s in candidates if is_scout_due(s.status, s.lastRunAt, now)]
    result: list[Scout] = []
    for scout in due:
        if not await _has_running_run(session, scout.id):
            result.append(scout)
    return result


async def run_scheduler_tick(
    session: AsyncSession, *, sqs_client=None, now: datetime | None = None
) -> list[str]:
    """Create a `PENDING` `ScoutRun` and enqueue `scout-intake` for every due
    Scout. Returns the created `ScoutRun` ids. `Scout.lastRunAt` itself is
    stamped later, by `dispatch_scout_run` — same as the manual path.
    """
    scouts = await due_scouts(session, now=now)
    if not scouts:
        return []

    run_ids: list[str] = []
    for scout in scouts:
        scout_run = ScoutRun(id=str(uuid.uuid4()), scoutId=scout.id, status=Scoutrunstatus.PENDING)
        session.add(scout_run)
        run_ids.append(scout_run.id)
    await session.commit()

    client = sqs_client or make_sqs_client()
    for run_id in run_ids:
        client.send_message(
            QueueUrl=SCOUT_INTAKE_QUEUE_URL,
            MessageBody=json.dumps({"scoutRunId": run_id}),
        )
    logger.info("scout_schedule.tick", extra={"fields": {"dueCount": len(run_ids)}})
    return run_ids


def run_scheduler_tick_once() -> list[str]:
    """Sync entrypoint the local worker calls on a fixed interval: opens its
    own engine/session and disposes it, mirroring
    `intake_handler.handle_scout_intake`.
    """

    async def _run() -> list[str]:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                return await run_scheduler_tick(session)
        finally:
            await engine.dispose()

    return asyncio.run(_run())
