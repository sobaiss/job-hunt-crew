"""Daily autonomous Scout scheduling (issue #57): the "due?" predicate and the
schedule-hour env lookup.

Hand-written, not sqlacodegen output — like `quota.py` / `scout_matching.py` —
so `services/scout` can use it without depending on `services/api` or
`services/ingestion` for it.
"""

import os
from datetime import datetime

from .models import Scoutstatus

DEFAULT_SCOUT_SCHEDULE_HOUR_UTC = 6


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
