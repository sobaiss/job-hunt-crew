"""End-of-fan-out Analysis creation (issue #27, slice 4).

Shared by both ingestion modes: once the discover/scrape/extract pipeline
has run for an `IngestionJob`, create one `Analysis` per linked `READY`
`JobOffer` — `userId` + `cvVersionId` carried on the `IngestionJob`,
`jobOfferId`, and `ingestionJobId` set — and enqueue `{"analysisId": id}`
on the `analysis-intake` queue so the existing `AnalysisWorkflow` completes
it unchanged (PRD Section 8.3 / 8.5, Section 10 step 3).

The per-user daily analysis cap (`DAILY_ANALYSIS_CAP`, default 50, counted
since 00:00 UTC — the same rule `POST /v1/analyses` enforces) is respected:
`Analysis` rows are created only up to the owner's remaining budget for the
day and the number of `READY` offers left unanalysed for that reason is
recorded on the `IngestionJob` without failing it. The candidate-facing
side of partial batches (pre-submit estimate, per-offer "daily limit
reached" markers, a dedicated column) is issue #33.
"""

import json
import os
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from py_db.models import (
    Analysis,
    Analysisstatus,
    IngestionJob,
    IngestionJobOffer,
    JobOffer,
    Jobofferextractionstatus,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .sqs_client import ANALYSIS_INTAKE_QUEUE_URL, make_sqs_client

DEFAULT_DAILY_ANALYSIS_CAP = 50


def _daily_analysis_cap() -> int:
    raw = os.environ.get("DAILY_ANALYSIS_CAP")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_DAILY_ANALYSIS_CAP


def _start_of_today() -> datetime:
    return datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@dataclass
class AnalysisFanoutResult:
    created_analysis_ids: list[str] = field(default_factory=list)
    quota_skipped_count: int = 0


async def create_analyses_for_ready_offers(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    *,
    sqs_client=None,
) -> AnalysisFanoutResult:
    """For each `READY` `JobOffer` linked to `ingestion_job` that does not yet
    have an `Analysis` for this job, create one `Analysis` (`userId` +
    `cvVersionId` from the job) and enqueue `{"analysisId": id}` on
    `analysis-intake`. Stops once the owner's `DAILY_ANALYSIS_CAP` for the
    day is reached, recording the count of offers left unanalysed on
    `ingestion_job.errorMessage`. Idempotent: re-running skips offers that
    already have an `Analysis` for this job, so an SQS redelivery does not
    double-create.
    """
    result = AnalysisFanoutResult()

    # New code always sets cvVersionId on the IngestionJob; a legacy row (or a
    # test fixture) without one has nothing to match against — no-op rather
    # than blow up on the NOT NULL Analysis.cvVersionId column.
    if not ingestion_job.cvVersionId:
        return result

    ready_offer_ids = (
        await session.scalars(
            select(JobOffer.id)
            .join(IngestionJobOffer, IngestionJobOffer.jobOfferId == JobOffer.id)
            .where(
                IngestionJobOffer.ingestionJobId == ingestion_job.id,
                JobOffer.extractionStatus == Jobofferextractionstatus.READY,
            )
            .order_by(IngestionJobOffer.createdAt, JobOffer.id)
        )
    ).all()
    if not ready_offer_ids:
        return result

    already_analysed = set(
        (
            await session.scalars(
                select(Analysis.jobOfferId).where(Analysis.ingestionJobId == ingestion_job.id)
            )
        ).all()
    )
    pending_offer_ids = [oid for oid in ready_offer_ids if oid not in already_analysed]
    if not pending_offer_ids:
        return result

    cap = _daily_analysis_cap()
    requested_today = (
        await session.scalar(
            select(func.count())
            .select_from(Analysis)
            .where(
                Analysis.userId == ingestion_job.userId,
                Analysis.requestedAt >= _start_of_today(),
            )
        )
        or 0
    )
    remaining = max(cap - requested_today, 0)

    to_create = pending_offer_ids[:remaining]
    skipped = len(pending_offer_ids) - len(to_create)

    for job_offer_id in to_create:
        analysis = Analysis(
            id=str(uuid.uuid4()),
            userId=ingestion_job.userId,
            jobOfferId=job_offer_id,
            cvVersionId=ingestion_job.cvVersionId,
            ingestionJobId=ingestion_job.id,
            status=Analysisstatus.PENDING,
        )
        session.add(analysis)
        result.created_analysis_ids.append(analysis.id)

    if skipped:
        note = (
            f"{skipped} READY offer(s) not analysed: daily analysis limit of {cap} "
            "reached for the job owner"
        )
        ingestion_job.errorMessage = (
            f"{ingestion_job.errorMessage}; {note}" if ingestion_job.errorMessage else note
        )
        ingestion_job.updatedAt = _now()
        result.quota_skipped_count = skipped

    await session.commit()

    if result.created_analysis_ids:
        client = sqs_client or make_sqs_client()
        for analysis_id in result.created_analysis_ids:
            client.send_message(
                QueueUrl=ANALYSIS_INTAKE_QUEUE_URL,
                MessageBody=json.dumps({"analysisId": analysis_id}),
            )

    return result
