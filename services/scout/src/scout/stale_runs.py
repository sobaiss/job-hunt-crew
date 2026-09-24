"""Closing ScoutRuns a dead worker abandoned (docs/adr/0032).

Both skip-on-overlap guards — `schedule.due_scouts` and
`dispatch.dispatch_scout_run` — refuse to start a run while another one is
`RUNNING`. That is the right rule while a run really is in flight, but a worker
killed mid-fan-out leaves the row `RUNNING` with nothing to finish it, and the
guard then silences that Scout's daily schedule permanently. docs/adr/0004 noted
this as having "no automatic timeout/recovery in v1"; this module is that
recovery.

There is no background sweeper. The staleness question is asked exactly where
the answer is needed — inside the overlap guard — and a run it steps over is
closed on the spot, so the run history never shows an eternal "in progress".
"""

from datetime import datetime

from py_db.models import ScoutRun, Scoutrunstatus
from py_db.scout_schedule import is_scout_run_stale
from py_db.structured_logging import get_logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

STALE_RUN_ERROR_MESSAGE = (
    "Run interrupted: the worker stopped mid-dispatch and never finished it"
)


async def close_stale_running_runs(
    session: AsyncSession,
    scout_id: str,
    *,
    now: datetime,
    exclude_run_id: str | None = None,
) -> bool:
    """Close every abandoned `RUNNING` run of `scout_id`, then report whether a
    live one is still holding the overlap lock.

    Returns `True` when a genuine `RUNNING` run remains (the caller must skip),
    `False` when none does — either because there were none or because the only
    ones left were stale and have just been marked `FAILED`.

    `exclude_run_id` is the caller's own run, so `dispatch_scout_run` can ask
    "is another run in flight?" without counting or closing itself.
    """
    stmt = select(ScoutRun).where(
        ScoutRun.scoutId == scout_id,
        ScoutRun.status == Scoutrunstatus.RUNNING,
    )
    if exclude_run_id is not None:
        stmt = stmt.where(ScoutRun.id != exclude_run_id)

    runs = (await session.scalars(stmt)).all()
    stale = [
        run
        for run in runs
        if is_scout_run_stale(run.status, run.startedAt, run.createdAt, now=now)
    ]

    for run in stale:
        run.status = Scoutrunstatus.FAILED
        run.errorMessage = STALE_RUN_ERROR_MESSAGE
        run.finishedAt = now
    if stale:
        await session.commit()
        logger.info(
            "scout_run.closed_stale",
            extra={
                "fields": {
                    "scoutId": scout_id,
                    "scoutRunIds": [run.id for run in stale],
                }
            },
        )

    return len(runs) > len(stale)
