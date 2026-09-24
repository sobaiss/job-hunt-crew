"""The "is this Analysis blocked?" predicate (docs/adr/0033).

Blocked is the narrower sibling of Stuck (`stuck_analysis.py`, docs/adr/0032):
a non-terminal Analysis that a Scout's Run state counts as genuinely broken
rather than merely waiting its turn in a fan-out. Stuck knowingly flags the
queued tail of a fan-out -- a false positive that is cheap on a per-row button
and ruinous in a per-Scout badge, where a healthy two-site run of fifty
serially-drained analyses would read red long before it finished.

The split is `startedAt`, which is on the row itself:

- picked up and then stalled -> blocked after `ANALYSIS_STUCK_AFTER_MINUTES`;
- never picked up -> the legitimate tail of a fan-out, blocked only after
  `SCOUT_QUEUED_BLOCKED_AFTER_MINUTES`.

**Blocked is a strict subset of Stuck, and that is load-bearing.** The Scout
panel fans `POST /v1/analyses/{id}/requeue` over `blockedAnalysisIds`, and that
endpoint gates on `is_analysis_stuck`; a blocked row that is not stuck would
come back `409 ANALYSIS_NOT_STUCK`. Both terms therefore sit at or past the
stuck threshold -- including when an operator sets the queued ceiling below it.

Three near-synonyms, three predicates: **stale** is a ScoutRun abandoned
mid-fan-out (`scout_schedule`), **stuck** is a non-terminal Analysis nothing
will advance, **blocked** is this subset of stuck.

Pure, like its neighbours -- no session, no query, no clock of its own -- so
one response judges every row against one `now`.
"""

from datetime import datetime, timedelta

from .models import Analysisstatus
from .stuck_analysis import (
    TERMINAL_ANALYSIS_STATUSES,
    _minutes_from_env,
    analysis_stuck_after,
)

# A never-started row is the tail of a fan-out for this long: 25 offers per
# site, drained one at a time by the local worker.
DEFAULT_SCOUT_QUEUED_BLOCKED_AFTER_MINUTES = 120


def scout_queued_blocked_after() -> timedelta:
    """`SCOUT_QUEUED_BLOCKED_AFTER_MINUTES` from the environment."""
    return timedelta(
        minutes=_minutes_from_env(
            "SCOUT_QUEUED_BLOCKED_AFTER_MINUTES",
            DEFAULT_SCOUT_QUEUED_BLOCKED_AFTER_MINUTES,
        )
    )


def is_analysis_blocked(
    status: Analysisstatus,
    requested_at: datetime,
    requeued_at: datetime | None,
    started_at: datetime | None,
    *,
    now: datetime,
    stuck_after: timedelta | None = None,
    queued_after: timedelta | None = None,
) -> bool:
    """Whether this Analysis is broken rather than queued. Pure.

    A started row is judged exactly as `is_analysis_stuck` judges it (clock:
    latest of the three timestamps). A never-started row is judged on the
    latest of `requestedAt` and `requeuedAt` against the queued ceiling, floored
    at the stuck threshold so the subset invariant survives any configuration.
    """
    if status in TERMINAL_ANALYSIS_STATUSES:
        return False

    stuck_after = stuck_after if stuck_after is not None else analysis_stuck_after()
    if started_at is not None:
        clock = max(ts for ts in (requested_at, requeued_at, started_at) if ts is not None)
        return now - clock > stuck_after

    queued_after = queued_after if queued_after is not None else scout_queued_blocked_after()
    clock = max(ts for ts in (requested_at, requeued_at) if ts is not None)
    return now - clock > max(queued_after, stuck_after)
