"""PipelineEvent writer (PRD Section 6 / M6-T3).

Hand-written (not sqlacodegen output) — the observability/debug trail's sole
write path, shared by both services/ingestion and services/analysis so every
pipeline stage (scrape, extract, crew, persist) records through the same
function regardless of which service runs it.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from .models import PipelineEvent


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def record_pipeline_event(
    session: AsyncSession,
    *,
    stage: str,
    status: str,
    message: str | None = None,
    analysis_id: str | None = None,
    ingestion_job_id: str | None = None,
) -> PipelineEvent:
    """Appends one PipelineEvent row. Purely additive observability — never
    raises on account of missing analysis_id/ingestion_job_id (a step may
    only have one of the two in context), and never rolls back the caller's
    own work (commits independently, on its own row).
    """
    event = PipelineEvent(
        id=str(uuid.uuid4()),
        analysisId=analysis_id,
        ingestionJobId=ingestion_job_id,
        stage=stage,
        status=status,
        message=message,
        createdAt=_now(),
    )
    session.add(event)
    await session.commit()
    return event
