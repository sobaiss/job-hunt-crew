"""The "is this Analysis stuck?" predicate (docs/adr/0032).

An `Analysis` can be abandoned mid-flight with no trace: the local queue holds
messages in memory only (`elasticmq.conf` declares no `messages-storage`, and
docker-compose.yml mounts only the read-only config), so a worker or ElasticMQ
restart drops every queued `analysis-intake` message while the row stays behind
in Postgres at a non-terminal status. Nothing re-reads such a row -- there is no
heartbeat, lock or attempt counter anywhere in the pipeline -- so it sits
"En attente" forever. `handlers.mark_analysis_failed` guarantees a terminal
status for every *caught* step failure, but cannot help when the process dies.

This module answers the question that decides whether the UI offers
"Relancer l'analyse" and whether `POST /v1/analyses/{id}/requeue` accepts. It is
a plain age check, evaluated on demand -- no session, no query, no background
watchdog, and nothing written on read.

It used to carry a second term: a global "is any PipelineEvent recent?" liveness
probe, meant to spare the tail of a Scout fan-out still waiting its turn. That
probe silenced the button far more often than it protected anything, because
*any* event anywhere re-armed it -- including the `requeue` event the repair
itself writes, so fixing one stranded row hid the button on every other one for
the next grace window. Judging each row on its own clock alone is the behaviour
docs/adr/0032 now records; the cost is a false positive on a legitimately queued
row, which `run_crew_task`'s terminal guard makes harmless.

Hand-written, not sqlacodegen output -- like `quota.py` / `scout_schedule.py` --
so any service can use it without depending on another.
"""

import os
from datetime import datetime, timedelta

from .models import Analysisstatus

# An Analysis is never declared stuck before this much time without progress.
# Short on purpose: with the liveness probe gone this is the only term, and a
# requeue is cheap (same row, no quota) while a row left stranded is invisible.
DEFAULT_ANALYSIS_STUCK_AFTER_MINUTES = 15

TERMINAL_ANALYSIS_STATUSES: frozenset[Analysisstatus] = frozenset(
    {Analysisstatus.COMPLETED, Analysisstatus.FAILED}
)


def _minutes_from_env(name: str, default: int) -> int:
    """A positive whole number of minutes from `name`, or `default` when it is
    unset, non-numeric or not positive. Mirrors `scout_schedule_hour_utc`'s
    tolerance: a malformed override falls back rather than crashing a worker.
    """
    raw = os.environ.get(name)
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else default


def analysis_stuck_after() -> timedelta:
    """`ANALYSIS_STUCK_AFTER_MINUTES` from the environment."""
    return timedelta(
        minutes=_minutes_from_env(
            "ANALYSIS_STUCK_AFTER_MINUTES", DEFAULT_ANALYSIS_STUCK_AFTER_MINUTES
        )
    )


def is_analysis_stuck(
    status: Analysisstatus,
    requested_at: datetime,
    requeued_at: datetime | None,
    started_at: datetime | None,
    *,
    now: datetime,
    stuck_after: timedelta | None = None,
) -> bool:
    """Whether this Analysis has been abandoned and should be offered for
    requeueing. Pure -- no session, no clock of its own.

    Two terms must hold:

    1. The status is non-terminal. A `COMPLETED` or `FAILED` Analysis is done;
       re-running one is the separate, quota-charged `POST /v1/analyses` of
       docs/adr/0011.
    2. Nothing has advanced it for `stuck_after`. The clock is the latest of
       `requestedAt`, `requeuedAt` and `startedAt`, so a requeue or a crew start
       both restart it -- which is also what bounds re-clicking to once per
       stuck window.
    """
    if status in TERMINAL_ANALYSIS_STATUSES:
        return False

    stuck_after = stuck_after if stuck_after is not None else analysis_stuck_after()
    clock = max(ts for ts in (requested_at, requeued_at, started_at) if ts is not None)
    return now - clock > stuck_after
