"""Shared SQL for the two Analyses tables' Statut filter and the candidate
table's sort.

Both tables (the candidate's `/analyses` and the Admin `/admin/analyses`) narrow
by the same seven Statut buckets, and since the candidate's filtering moved
server-side there are two callers building the same predicates. The vocabulary
is the frontend's `lib/tracking-status.ts`, mirrored here rather than re-derived:
five Tracking status buckets folded from the linked Application, plus `PENDING`
and `FAILED` matched against `Analysis.status` directly.

What the two tables do *not* share is the interaction — the candidate's takes
any number of buckets at once, the Admin's exactly one — which is why this
module hands out one condition per bucket and lets each caller decide whether to
OR them together.
"""

from typing import Literal

from py_db.models import Analysis, Analysisstatus, Application, Applicationstatus
from sqlalchemy import ColumnElement, and_, or_

AnalysesStatusFilter = Literal[
    "TO_APPLY", "IN_PROGRESS", "REJECTED", "ACCEPTED", "WITHDRAWN", "PENDING", "FAILED"
]

# The buckets naming a raw pipeline status rather than a Tracking one --
# `PIPELINE_ANALYSES_STATUS_FILTERS` in the frontend's `lib/tracking-status.ts`.
PIPELINE_STATUS_FILTERS: dict[str, Analysisstatus] = {
    "PENDING": Analysisstatus.PENDING,
    "FAILED": Analysisstatus.FAILED,
}

# Mirrors `APPLICATION_STATUS_TO_TRACKING` in the frontend's
# `lib/tracking-status.ts`. DRAFT is absent on purpose: it folds into TO_APPLY,
# which also has to match an Analysis with no Application row at all.
TRACKING_STATUS_TO_APPLICATION_STATUSES: dict[str, list[Applicationstatus]] = {
    "IN_PROGRESS": [
        Applicationstatus.APPLIED,
        Applicationstatus.INTERVIEWING,
        Applicationstatus.OFFER,
    ],
    "REJECTED": [Applicationstatus.REJECTED],
    "ACCEPTED": [Applicationstatus.ACCEPTED],
    "WITHDRAWN": [Applicationstatus.WITHDRAWN],
}


def status_bucket_condition(bucket: AnalysesStatusFilter) -> ColumnElement[bool]:
    """One bucket as a WHERE condition, for a statement that has already
    **outer**-joined `Application`.

    Outer, even for the buckets that need an Application row: an inner join
    would be equivalent for those (a NULL status matches no `IN`), but it would
    make the join's kind depend on which bucket was asked for — impossible once
    several buckets are OR-ed in one statement. `Application.analysisId` is
    unique, so the outer join cannot multiply rows either way.
    """
    if bucket in PIPELINE_STATUS_FILTERS:
        return Analysis.status == PIPELINE_STATUS_FILTERS[bucket]
    if bucket == "TO_APPLY":
        return and_(
            Analysis.status == Analysisstatus.COMPLETED,
            or_(Application.id.is_(None), Application.status == Applicationstatus.DRAFT),
        )
    return and_(
        Analysis.status == Analysisstatus.COMPLETED,
        Application.status.in_(TRACKING_STATUS_TO_APPLICATION_STATUSES[bucket]),
    )
