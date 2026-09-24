"""The stuck-Analysis predicate (`py_db.stuck_analysis`), the rule that decides
whether the Web offers "Relancer l'analyse" and whether
`POST /v1/analyses/{id}/requeue` accepts (docs/adr/0032). The HTTP-level
behaviour of that endpoint is covered by `test_v1_analyses.py`; this file pins
the predicate itself.
"""

from datetime import datetime, timedelta

import pytest
from py_db.models import Analysisstatus
from py_db.stuck_analysis import is_analysis_stuck

NOW = datetime(2026, 9, 24, 12, 0, 0)
STUCK_AFTER = timedelta(minutes=15)

LONG_AGO = NOW - timedelta(hours=3)
JUST_NOW = NOW - timedelta(minutes=1)


def _stuck(
    status: Analysisstatus,
    *,
    requested_at: datetime = LONG_AGO,
    requeued_at: datetime | None = None,
    started_at: datetime | None = None,
) -> bool:
    return is_analysis_stuck(
        status,
        requested_at,
        requeued_at,
        started_at,
        now=NOW,
        stuck_after=STUCK_AFTER,
    )


@pytest.mark.parametrize("status", [Analysisstatus.COMPLETED, Analysisstatus.FAILED])
def test_a_terminal_analysis_is_never_stuck(status):
    """However old: re-running one of these is the separate, quota-charged
    `POST /v1/analyses` of docs/adr/0011."""
    assert _stuck(status, started_at=LONG_AGO) is False


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
def test_any_overdue_non_terminal_analysis_is_stuck(status):
    """The whole rule, at every non-terminal status: past the threshold with
    nothing advancing it, the row is offered for requeueing.

    This is the user's incident — 22 rows left at PENDING by a
    `docker compose restart`, each with no PipelineEvent of its own — and it is
    deliberately the *same* answer for a row that may still be queued behind a
    Scout fan-out. The predicate no longer tries to tell those apart; see
    `test_crew_task.py` for the duplicate-message guard that pays for it.
    """
    assert _stuck(status, requested_at=LONG_AGO, started_at=None)


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
    """Inside the threshold nothing is declared dead, whatever the status — an
    analysis is allowed to take its time."""
    assert _stuck(status, requested_at=JUST_NOW, started_at=JUST_NOW) is False


def test_the_clock_is_the_latest_of_the_three_timestamps():
    """A requeue restarts the staleness clock, which is what stops the button
    inviting a second click straight away."""
    assert _stuck(
        Analysisstatus.PENDING, requested_at=LONG_AGO, requeued_at=LONG_AGO
    ), "an old requeue leaves the row stuck"
    assert (
        _stuck(Analysisstatus.PENDING, requested_at=LONG_AGO, requeued_at=JUST_NOW)
        is False
    ), "a fresh requeue restarts the clock"
    assert (
        _stuck(Analysisstatus.PENDING, requested_at=LONG_AGO, started_at=JUST_NOW)
        is False
    ), "a fresh crew start restarts the clock"


def test_the_threshold_boundary_is_exclusive():
    """Exactly at `stuck_after` the row is not yet stuck. Pins the comparison so
    a later `<` vs `<=` edit is a visible behaviour change."""
    assert _stuck(Analysisstatus.PENDING, requested_at=NOW - STUCK_AFTER) is False
    assert _stuck(
        Analysisstatus.PENDING, requested_at=NOW - STUCK_AFTER - timedelta(seconds=1)
    )


def test_the_threshold_defaults_to_the_environment(monkeypatch):
    """`ANALYSIS_STUCK_AFTER_MINUTES` is the one knob, read per call so an
    operator can widen the window without a redeploy."""
    monkeypatch.setenv("ANALYSIS_STUCK_AFTER_MINUTES", "240")
    assert (
        is_analysis_stuck(
            Analysisstatus.PENDING,
            NOW - timedelta(hours=3),
            None,
            None,
            now=NOW,
        )
        is False
    ), "a 4-hour window spares a 3-hour-old row"

    monkeypatch.setenv("ANALYSIS_STUCK_AFTER_MINUTES", "not-a-number")
    assert is_analysis_stuck(
        Analysisstatus.PENDING,
        NOW - timedelta(hours=3),
        None,
        None,
        now=NOW,
    ), "a malformed override falls back to the 15-minute default"
