"""Daily autonomous Scout scheduling (issue #57): the "due?" predicate, the
schedule-hour env lookup, and the "this RUNNING run was abandoned" predicate.

Hand-written, not sqlacodegen output — like `quota.py` / `scout_matching.py` —
so `services/scout` can use it without depending on `services/api` or
`services/ingestion` for it.
"""

import os
from datetime import datetime, timedelta

from .models import Scoutrunstatus, Scoutstatus

DEFAULT_SCOUT_SCHEDULE_HOUR_UTC = 6

# A ScoutRun is RUNNING only while `dispatch_scout_run` fans out: DB writes and
# SQS sends, no LLM call anywhere. Seconds of work, so a RUNNING run this old
# can only mean the process died mid-fan-out.
DEFAULT_SCOUT_RUN_STUCK_AFTER_MINUTES = 20


def scout_schedule_hour_utc() -> int:
    """`SCOUT_SCHEDULE_HOUR_UTC` (0-23) from the environment, or
    `DEFAULT_SCOUT_SCHEDULE_HOUR_UTC` when it is unset, non-numeric, or out of
    range.
    """
    raw = os.environ.get("SCOUT_SCHEDULE_HOUR_UTC")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    if parsed is not None and 0 <= parsed <= 23:
        return parsed
    return DEFAULT_SCOUT_SCHEDULE_HOUR_UTC


def is_scout_due(
    status: Scoutstatus,
    last_run_at: datetime | None,
    now: datetime,
    *,
    schedule_hour: int | None = None,
) -> bool:
    """A Scout is due for its daily run when it is `ACTIVE`, `now` is at or
    past today's scheduled UTC hour, and it has not already run since that
    hour today (`last_run_at` is `None` or before it).

    A missed day is never backfilled: once `last_run_at` moves past today's
    scheduled hour (a run has landed), the same Scout stops being due until
    tomorrow's hour — regardless of how many days it may have missed before
    that.
    """
    if status != Scoutstatus.ACTIVE:
        return False
    hour = schedule_hour if schedule_hour is not None else scout_schedule_hour_utc()
    scheduled_today = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if now < scheduled_today:
        return False
    return last_run_at is None or last_run_at < scheduled_today


def scout_run_stuck_after() -> timedelta:
    """`SCOUT_RUN_STUCK_AFTER_MINUTES` from the environment, or
    `DEFAULT_SCOUT_RUN_STUCK_AFTER_MINUTES` when it is unset, non-numeric or not
    positive.
    """
    raw = os.environ.get("SCOUT_RUN_STUCK_AFTER_MINUTES")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    minutes = parsed if parsed is not None and parsed > 0 else DEFAULT_SCOUT_RUN_STUCK_AFTER_MINUTES
    return timedelta(minutes=minutes)


def is_scout_run_stale(
    status: Scoutrunstatus,
    started_at: datetime | None,
    created_at: datetime,
    *,
    now: datetime,
    stuck_after: timedelta | None = None,
) -> bool:
    """Whether a `RUNNING` ScoutRun was abandoned by a dead worker (docs/adr/0032).

    This matters more than it looks: both skip-on-overlap guards
    (`scout.schedule.due_scouts` and `dispatch_scout_run`) refuse to start a run
    while another is `RUNNING`, so one abandoned run silences its Scout's daily
    schedule permanently — the failure mode docs/adr/0004 flagged as having "no
    automatic timeout/recovery in v1".

    Only `RUNNING` can go stale. `PENDING` is a run that was created but never
    dispatched; it holds no lock over the Scout and is left alone. The clock is
    `startedAt` (stamped in the same commit as `RUNNING`), falling back to
    `createdAt` for a row that somehow lacks it.
    """
    if status != Scoutrunstatus.RUNNING:
        return False
    stuck_after = stuck_after if stuck_after is not None else scout_run_stuck_after()
    return now - (started_at or created_at) > stuck_after
