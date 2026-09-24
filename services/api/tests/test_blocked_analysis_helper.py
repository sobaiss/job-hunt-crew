"""The blocked-Analysis predicate (`py_db.blocked_analysis`), the narrower
sibling of Stuck that a Scout's Run state counts as broken rather than merely
queued (docs/adr/0033). Nothing reads it over HTTP yet; this file pins the rule
and, above all, the subset invariant the Scout panel's repair button relies on.
"""

from datetime import datetime, timedelta
from itertools import product

import pytest
from py_db.blocked_analysis import is_analysis_blocked
from py_db.models import Analysisstatus
from py_db.stuck_analysis import TERMINAL_ANALYSIS_STATUSES, is_analysis_stuck

NOW = datetime(2026, 9, 24, 12, 0, 0)
STUCK_AFTER = timedelta(minutes=15)
QUEUED_AFTER = timedelta(minutes=120)

NON_TERMINAL = [s for s in Analysisstatus if s not in TERMINAL_ANALYSIS_STATUSES]


def _ago(minutes: float) -> datetime:
    return NOW - timedelta(minutes=minutes)


def _blocked(
    status: Analysisstatus,
    *,
    requested_at: datetime,
    requeued_at: datetime | None = None,
    started_at: datetime | None = None,
) -> bool:
    return is_analysis_blocked(
        status,
        requested_at,
        requeued_at,
        started_at,
        now=NOW,
        stuck_after=STUCK_AFTER,
        queued_after=QUEUED_AFTER,
    )


# (description, status, requested, requeued, started, expected)
CASES = [
    ("started, stalled past stuck", Analysisstatus.RUNNING_CREW, _ago(60), None, _ago(16), True),
    ("started, a minute before stuck", Analysisstatus.RUNNING_CREW, _ago(60), None, _ago(14), False),
    ("started, exactly at stuck", Analysisstatus.RUNNING_CREW, _ago(60), None, _ago(15), False),
    ("never started, forty minutes", Analysisstatus.PENDING, _ago(40), None, None, False),
    ("never started, a minute before ceiling", Analysisstatus.QUEUED, _ago(119), None, None, False),
    ("never started, past ceiling", Analysisstatus.PENDING, _ago(121), None, None, True),
    ("never started, old but freshly requeued", Analysisstatus.PENDING, _ago(300), _ago(10), None, False),
    ("never started, old requeue past ceiling", Analysisstatus.PENDING, _ago(300), _ago(121), None, True),
    ("started, stalled but freshly requeued", Analysisstatus.RUNNING_CREW, _ago(300), _ago(5), _ago(60), False),
    ("terminal COMPLETED, ancient", Analysisstatus.COMPLETED, _ago(10_000), None, _ago(10_000), False),
    ("terminal FAILED, ancient", Analysisstatus.FAILED, _ago(10_000), None, None, False),
]


@pytest.mark.parametrize(
    "status,requested,requeued,started,expected",
    [c[1:] for c in CASES],
    ids=[c[0] for c in CASES],
)
def test_the_blocked_rule(status, requested, requeued, started, expected):
    assert (
        _blocked(
            status, requested_at=requested, requeued_at=requeued, started_at=started
        )
        is expected
    )


@pytest.mark.parametrize("status", NON_TERMINAL)
def test_the_rule_holds_at_every_non_terminal_status(status):
    """The split is on `startedAt`, never on the status: which non-terminal
    status a stalled row sits at says nothing about whether it was picked up."""
    assert _blocked(status, requested_at=_ago(60), started_at=_ago(20))
    assert not _blocked(status, requested_at=_ago(60), started_at=None)


def test_every_blocked_analysis_is_also_stuck():
    """The subset invariant (docs/adr/0033). The Scout panel fans
    `POST /v1/analyses/{id}/requeue` over `blockedAnalysisIds`, and that
    endpoint gates on `is_analysis_stuck`; a blocked row that is not stuck would
    come back `409 ANALYSIS_NOT_STUCK` and the repair would fail silently.
    Swept over a grid of ages either side of both thresholds."""
    ages: list[float | None] = [None, 0, 1, 14, 15, 16, 40, 119, 120, 121, 500]
    checked = 0
    for status, requested, requeued, started in product(
        list(Analysisstatus), [a for a in ages if a is not None], ages, ages
    ):
        args = (
            status,
            _ago(requested),
            _ago(requeued) if requeued is not None else None,
            _ago(started) if started is not None else None,
        )
        if _blocked(
            args[0], requested_at=args[1], requeued_at=args[2], started_at=args[3]
        ):
            checked += 1
            assert is_analysis_stuck(*args, now=NOW, stuck_after=STUCK_AFTER), args
    assert checked, "the sweep must exercise some blocked rows"


def test_a_queued_ceiling_below_the_stuck_threshold_cannot_break_the_subset():
    """An operator lowering `SCOUT_QUEUED_BLOCKED_AFTER_MINUTES` under
    `ANALYSIS_STUCK_AFTER_MINUTES` would otherwise make a queued row blocked
    before it is stuck. The stuck threshold is the floor."""
    args = (Analysisstatus.PENDING, _ago(10), None, None)
    assert not is_analysis_stuck(*args, now=NOW, stuck_after=STUCK_AFTER)
    assert not is_analysis_blocked(
        *args,
        now=NOW,
        stuck_after=STUCK_AFTER,
        queued_after=timedelta(minutes=5),
    )


def test_both_thresholds_default_to_the_environment(monkeypatch):
    """Read per call, like `ANALYSIS_STUCK_AFTER_MINUTES`."""
    never_started = (Analysisstatus.PENDING, _ago(90), None, None)
    monkeypatch.delenv("SCOUT_QUEUED_BLOCKED_AFTER_MINUTES", raising=False)
    monkeypatch.delenv("ANALYSIS_STUCK_AFTER_MINUTES", raising=False)
    assert not is_analysis_blocked(*never_started, now=NOW), "default is 120"

    monkeypatch.setenv("SCOUT_QUEUED_BLOCKED_AFTER_MINUTES", "60")
    assert is_analysis_blocked(*never_started, now=NOW), "override honoured"

    monkeypatch.setenv("ANALYSIS_STUCK_AFTER_MINUTES", "30")
    stalled = (Analysisstatus.RUNNING_CREW, _ago(90), None, _ago(20))
    assert not is_analysis_blocked(*stalled, now=NOW), "stuck knob drives the started term"


@pytest.mark.parametrize("raw", ["", "not-a-number", "0", "-5"])
def test_a_malformed_queued_ceiling_falls_back_to_its_default(monkeypatch, raw):
    monkeypatch.delenv("ANALYSIS_STUCK_AFTER_MINUTES", raising=False)
    monkeypatch.setenv("SCOUT_QUEUED_BLOCKED_AFTER_MINUTES", raw)
    assert not is_analysis_blocked(Analysisstatus.PENDING, _ago(119), None, None, now=NOW)
    assert is_analysis_blocked(Analysisstatus.PENDING, _ago(121), None, None, now=NOW)
