"""Applications + per-Scout statistics (issue #60): offers discovered,
relevant finds, documents generated, applications submitted, the funnel
rates (response/interview/offer/acceptance), and the median days to first
response — each computed for two windows (all-time and the last 30 days) by
calling `compute_application_stats` twice with a different `since` cutoff.

Global (`scout_id=None`) backs the Applications view's stats header;
scoped (`scout_id=<id>`) backs the same header on a Scout's detail page.

Hand-written (not sqlacodegen output), like quota.py / scout_matching.py.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .models import (
    Analysis,
    Analysisstatus,
    Application,
    Applicationstatus,
    GeneratedDocument,
    Generateddocumentstatus,
    Scout,
    ScoutRun,
)

STATS_WINDOW_DAYS = 30

# A "response" is any status the candidate did not choose unprompted —
# WITHDRAWN is excluded since that's the candidate acting, not the employer.
_RESPONSE_STATUSES = {
    Applicationstatus.INTERVIEWING,
    Applicationstatus.OFFER,
    Applicationstatus.ACCEPTED,
    Applicationstatus.REJECTED,
}


@dataclass
class ApplicationStatsWindow:
    offersDiscovered: int
    relevantFinds: int
    documentsGenerated: int
    applicationsSubmitted: int
    responseRate: float
    interviewRate: float
    offerRate: float
    acceptanceRate: float
    medianDaysToFirstResponse: float | None


def stats_window_since(now: datetime | None = None) -> datetime:
    """Naive-UTC cutoff for the "last 30 days" window — Prisma's DateTime
    columns are TIMESTAMP WITHOUT TIME ZONE, so tzinfo is stripped after
    computing the cutoff in UTC, matching quota.py's convention."""
    base = now or datetime.now(UTC)
    return (base - timedelta(days=STATS_WINDOW_DAYS)).replace(tzinfo=None)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


async def compute_application_stats(
    session: AsyncSession,
    user_id: str,
    *,
    scout_id: str | None = None,
    since: datetime | None = None,
) -> ApplicationStatsWindow:
    offers_discovered = await _offers_discovered(session, user_id, scout_id, since)
    relevant_finds = await _relevant_finds(session, user_id, scout_id, since)
    documents_generated = await _documents_generated(session, user_id, scout_id, since)
    applications = await _submitted_applications(session, user_id, scout_id, since)

    submitted = len(applications)
    responded = interviewed = offered = accepted = 0
    first_response_days: list[float] = []

    for application in applications:
        events = sorted(application.StatusEvent, key=lambda e: (e.effectiveDate, e.createdAt))
        statuses_reached = {e.status for e in events}
        if statuses_reached & _RESPONSE_STATUSES:
            responded += 1
        if Applicationstatus.INTERVIEWING in statuses_reached:
            interviewed += 1
        if Applicationstatus.OFFER in statuses_reached:
            offered += 1
        if Applicationstatus.ACCEPTED in statuses_reached:
            accepted += 1

        first_response = next((e for e in events if e.status in _RESPONSE_STATUSES), None)
        if first_response is not None and application.appliedAt is not None:
            delta = first_response.effectiveDate - application.appliedAt
            first_response_days.append(max(delta.total_seconds() / 86400, 0.0))

    def rate(count: int) -> float:
        return round(count / submitted * 100, 1) if submitted else 0.0

    return ApplicationStatsWindow(
        offersDiscovered=offers_discovered,
        relevantFinds=relevant_finds,
        documentsGenerated=documents_generated,
        applicationsSubmitted=submitted,
        responseRate=rate(responded),
        interviewRate=rate(interviewed),
        offerRate=rate(offered),
        acceptanceRate=rate(accepted),
        medianDaysToFirstResponse=_median(first_response_days),
    )


async def _offers_discovered(
    session: AsyncSession, user_id: str, scout_id: str | None, since: datetime | None
) -> int:
    stmt = (
        select(func.coalesce(func.sum(ScoutRun.offersDiscovered), 0))
        .select_from(ScoutRun)
        .join(Scout, Scout.id == ScoutRun.scoutId)
        .where(Scout.userId == user_id)
    )
    if scout_id is not None:
        stmt = stmt.where(Scout.id == scout_id)
    if since is not None:
        stmt = stmt.where(ScoutRun.createdAt >= since)
    return int((await session.scalar(stmt)) or 0)


async def _relevant_finds(
    session: AsyncSession, user_id: str, scout_id: str | None, since: datetime | None
) -> int:
    stmt = (
        select(func.count())
        .select_from(Analysis)
        .join(Scout, Scout.id == Analysis.scoutId)
        .where(
            Scout.userId == user_id,
            Analysis.status == Analysisstatus.COMPLETED,
            Analysis.matchScore >= Scout.matchThreshold,
        )
    )
    if scout_id is not None:
        stmt = stmt.where(Scout.id == scout_id)
    if since is not None:
        stmt = stmt.where(Analysis.completedAt >= since)
    return int((await session.scalar(stmt)) or 0)


async def _documents_generated(
    session: AsyncSession, user_id: str, scout_id: str | None, since: datetime | None
) -> int:
    stmt = (
        select(func.count())
        .select_from(GeneratedDocument)
        .join(Analysis, Analysis.id == GeneratedDocument.analysisId)
        .where(
            Analysis.userId == user_id,
            GeneratedDocument.status == Generateddocumentstatus.READY,
        )
    )
    if scout_id is not None:
        stmt = stmt.where(Analysis.scoutId == scout_id)
    if since is not None:
        stmt = stmt.where(GeneratedDocument.createdAt >= since)
    return int((await session.scalar(stmt)) or 0)


async def _submitted_applications(
    session: AsyncSession, user_id: str, scout_id: str | None, since: datetime | None
) -> list[Application]:
    stmt = (
        select(Application)
        .options(selectinload(Application.StatusEvent))
        .where(Application.userId == user_id, Application.appliedAt.is_not(None))
    )
    if scout_id is not None:
        stmt = stmt.where(Application.scoutId == scout_id)
    if since is not None:
        stmt = stmt.where(Application.appliedAt >= since)
    return list((await session.scalars(stmt)).all())
