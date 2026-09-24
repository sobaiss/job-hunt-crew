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
evaluated on demand, at the moment the answer is needed -- there is no
background watchdog and nothing is written on read.

Hand-written, not sqlacodegen output -- like `quota.py` / `scout_schedule.py` --
so any service can use it without depending on another.
"""

import os
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Analysisstatus, PipelineEvent

# An Analysis is never declared stuck before this much time without progress.
DEFAULT_ANALYSIS_STUCK_AFTER_MINUTES = 20

# How recently a PipelineEvent must have been written for the pipeline to count
# as alive. Shorter than the stuck threshold on purpose: the question is only
# "is anything still moving?", and the slowest single step (an LLM extraction or
# crew run) stays well inside it.
DEFAULT_PIPELINE_IDLE_GRACE_MINUTES = 15

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


def pipeline_idle_grace() -> timedelta:
    """`PIPELINE_IDLE_GRACE_MINUTES` from the environment."""
    return timedelta(
        minutes=_minutes_from_env(
            "PIPELINE_IDLE_GRACE_MINUTES", DEFAULT_PIPELINE_IDLE_GRACE_MINUTES
        )
    )


async def latest_pipeline_activity(session: AsyncSession) -> datetime | None:
    """The newest `PipelineEvent.createdAt` across the whole pipeline, or `None`
    when the trail is empty -- the liveness probe `is_analysis_stuck` uses.

    `record_pipeline_event` commits on its own row, independently of the caller's
    work, so this trail survives the crash it documents and is the one signal
    that reliably distinguishes "the worker is chewing through a backlog" from
    "the worker is gone". Backed by `PipelineEvent_createdAt_idx`; callers
    resolve it once per request and pass the value down, never once per row.
    """
    return await session.scalar(select(func.max(PipelineEvent.createdAt)))


def is_analysis_stuck(
    status: Analysisstatus,
    requested_at: datetime,
    requeued_at: datetime | None,
    started_at: datetime | None,
    *,
    now: datetime,
    last_pipeline_activity: datetime | None,
    stuck_after: timedelta | None = None,
    idle_grace: timedelta | None = None,
) -> bool:
    """Whether this Analysis has been abandoned and should be offered for
    requeueing. Pure -- no session, no clock of its own.

    Three terms must hold:

    1. The status is non-terminal. A `COMPLETED` or `FAILED` Analysis is done;
       re-running one is the separate, quota-charged `POST /v1/analyses` of
       docs/adr/0011.
    2. Nothing has advanced it for `stuck_after`. The clock is the latest of
       `requestedAt`, `requeuedAt` and `startedAt`, so a requeue or a crew start
       both restart it.
    3. Either it had already started, or the pipeline as a whole is idle.

    That third term is what keeps a legitimate backlog safe, and it is the whole
    reason this is not a plain age check. `startedAt` set means a worker was
    actively inside this row (`crew_task` stamps it), so nothing is queued behind
    it and a timeout can only mean abandonment. `startedAt` null means the row
    may simply be waiting its turn: a Scout fans out up to
    `SCOUT_INGESTION_MAX_OFFERS` (25) offers *per site* and the local worker
    drains them one at a time, so the tail of a multi-site run can legitimately
    wait hours. An age-only rule would declare that whole tail dead. Asking
    whether any PipelineEvent landed recently settles it without a watchdog:
    while the chain advances, a queued row is waiting, not lost.
    """
    if status in TERMINAL_ANALYSIS_STATUSES:
        return False

    stuck_after = stuck_after if stuck_after is not None else analysis_stuck_after()
    clock = max(ts for ts in (requested_at, requeued_at, started_at) if ts is not None)
    if now - clock <= stuck_after:
        return False

    if started_at is not None:
        return True

    idle_grace = idle_grace if idle_grace is not None else pipeline_idle_grace()
    pipeline_alive = (
        last_pipeline_activity is not None
        and now - last_pipeline_activity <= idle_grace
    )
    return not pipeline_alive
