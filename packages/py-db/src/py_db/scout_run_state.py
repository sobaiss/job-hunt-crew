"""A Scout's Run state, derived on read from its pipeline rows (docs/adr/0033).

Whether a Scout is working right now and, if not, whether something is wrong.
Derived from the rows the Scout's runs produced -- **never** from
`ScoutRun.status`, whose `RUNNING` spans only `dispatch_scout_run`'s fan-out and
is terminal within seconds of a run starting.

The unit is the Scout, not one of its runs: a straggler from the previous run
counts as work in progress, because it is.

Pure, like `blocked_analysis` and `scout_schedule`: the caller fetches the rows
(grouped, one query per kind for a whole list) and passes one `now`, so every
Scout in a response is judged against the same clock. It lives here rather than
in the API so the Admin scouts table can later read the same answer.
"""

import enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import NamedTuple

from .blocked_analysis import is_analysis_blocked
from .models import Analysisstatus, ScoutRun, Scoutrunstatus
from .scout_schedule import is_scout_run_stale


class RunState(str, enum.Enum):
    """Listed in precedence order: when several hold at once, the first wins.
    Work happening now outranks a verdict inherited from the previous run.

    This is deliberately not the order the Execution column sorts by -- that
    is worst-first, and lives with the column.
    """

    IN_FLIGHT = "IN_FLIGHT"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"
    DEGRADED = "DEGRADED"
    NEVER_RUN = "NEVER_RUN"
    OK = "OK"


class OpenAnalysis(NamedTuple):
    """A non-terminal Analysis reached by its own `scoutId`."""

    id: str
    status: Analysisstatus
    requestedAt: datetime
    requeuedAt: datetime | None
    startedAt: datetime | None


@dataclass(frozen=True)
class ScoutRunState:
    state: RunState
    # The oldest clock behind the state; only for IN_FLIGHT and BLOCKED. The
    # other states already have a date on screen in the Last-run column.
    since: datetime | None = None
    # Empty unless BLOCKED: exactly the rows the Scout panel's repair re-drives.
    blocked_analysis_ids: list[str] = field(default_factory=list)


def derive_scout_run_state(
    *,
    last_run_at: datetime | None,
    latest_run: ScoutRun | None,
    oldest_open_ingestion_job_at: datetime | None,
    open_analyses: list[OpenAnalysis],
    now: datetime,
) -> ScoutRunState:
    """One Scout's Run state. Pure.

    - `latest_run`: the Scout's most recently created ScoutRun, if any.
    - `oldest_open_ingestion_job_at`: `min(createdAt)` over the non-terminal
      IngestionJobs on any of the Scout's runs, or None.
    - `open_analyses`: every non-terminal Analysis carrying the Scout's id.
    """
    blocked: list[OpenAnalysis] = []
    unblocked: list[OpenAnalysis] = []
    for row in open_analyses:
        is_blocked = is_analysis_blocked(
            row.status, row.requestedAt, row.requeuedAt, row.startedAt, now=now
        )
        (blocked if is_blocked else unblocked).append(row)

    # IN_FLIGHT: any of three shapes the work passes through, so there is no
    # gap between them where the Scout reads as idle.
    in_flight_clocks: list[datetime] = []
    if latest_run is not None and (
        latest_run.status == Scoutrunstatus.PENDING
        or (
            latest_run.status == Scoutrunstatus.RUNNING
            and not _is_stale(latest_run, now)
        )
    ):
        in_flight_clocks.append(latest_run.startedAt or latest_run.createdAt)
    if oldest_open_ingestion_job_at is not None:
        in_flight_clocks.append(oldest_open_ingestion_job_at)
    in_flight_clocks.extend(row.requestedAt for row in unblocked)
    if in_flight_clocks:
        return ScoutRunState(RunState.IN_FLIGHT, since=min(in_flight_clocks))

    if blocked:
        return ScoutRunState(
            RunState.BLOCKED,
            since=min(_blocked_clock(row) for row in blocked),
            blocked_analysis_ids=[row.id for row in blocked],
        )

    if latest_run is not None:
        # A RUNNING run left here is stale: anticipate, by one guard, the
        # FAILED that `close_stale_running_runs` will write to it anyway.
        if latest_run.status in (Scoutrunstatus.FAILED, Scoutrunstatus.RUNNING):
            return ScoutRunState(RunState.FAILED)
        if (
            latest_run.status == Scoutrunstatus.PARTIALLY_COMPLETED
            or latest_run.failedCount > 0
        ):
            return ScoutRunState(RunState.DEGRADED)

    if last_run_at is None:
        return ScoutRunState(RunState.NEVER_RUN)
    return ScoutRunState(RunState.OK)


def _is_stale(run: ScoutRun, now: datetime) -> bool:
    return is_scout_run_stale(run.status, run.startedAt, run.createdAt, now=now)


def _blocked_clock(row: OpenAnalysis) -> datetime:
    """The clock `is_analysis_blocked` judged this row on."""
    stamps = (row.requestedAt, row.requeuedAt, row.startedAt)
    return max(ts for ts in stamps if ts is not None)
