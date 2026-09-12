"""End-of-fan-out Analysis creation (issue #27, slice 4).

Shared by both ingestion modes: once the discover/scrape/extract pipeline
has run for an `IngestionJob`, create one `Analysis` per linked `READY`
`JobOffer` — `userId` + `cvVersionId` carried on the `IngestionJob`,
`jobOfferId`, and `ingestionJobId` set — and enqueue `{"analysisId": id}`
on the `analysis-intake` queue so the existing `AnalysisWorkflow` completes
it unchanged (PRD Section 8.3 / 8.5, Section 10 step 3).

A job fanned out by a Scout run (`IngestionJob.scoutRunId` set) additionally
stamps each created `Analysis` with the denormalised `scoutId` so the Scout
detail view, per-Scout stats, and cross-run dedup can query without a join
(issue #54).

The per-user daily analysis cap (`DAILY_ANALYSIS_CAP`, default 50, counted
since 00:00 UTC — the same rule `POST /v1/analyses` enforces) is respected:
`Analysis` rows are created only up to the owner's remaining budget for the
day and the number of `READY` offers left unanalysed for that reason is
recorded on `IngestionJob.quotaSkippedCount` without failing the job. The
remaining candidate-facing side of partial batches (per-offer "daily limit
reached" markers on the Batch result view) is issue #33.

Cost-bounded Scout matching (issue #55): a Scout job's candidate offers go
through two more gates before the daily cap, neither of which touch the
manual flows (no `scoutRunId` -> skip straight to the unchanged path):
- **cross-run dedup** — an offer this Scout already has an `Analysis` for
  (any previous run, matched by the denormalised `Analysis.scoutId`) is
  skipped and counted `IngestionJob.alreadySeenCount` ("already seen").
- **per-run ceiling** — the survivors are ranked by a no-LLM lexical
  similarity between their scraped title/description and the Scout's base CV
  (`py_db.scout_matching.lexical_similarity`), then cut to whatever remains
  of `SCOUT_MAX_ANALYSES_PER_RUN` across every `IngestionJob` (site) the run
  has fanned out to so far; the overflow is counted
  `IngestionJob.runLimitSkippedCount` ("not analysed - run limit").

Extraction gating (issue #55 follow-up): `ingestion.fanout`'s
`_scrape_all_then_extract_within_ceiling` now applies this same ranking
*before* extraction runs — an offer beyond what's left of the ceiling is
scraped but never extracted, saving the extraction-LLM call, and is counted
on `IngestionJob.extractionSkippedCount`. By the time this module runs, most
Scout offers were already gated there, so the ranking here mostly re-confirms
an already-bounded set; it still matters for a `JobOffer` that reached
`READY` via a different job/run entirely (globally deduped by `sourceUrl`)
and so never passed through this run's own extraction gate.
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    IngestionJob,
    IngestionJobOffer,
    JobOffer,
    Jobofferextractionstatus,
    ScoutRun,
)
from py_db.quota import analyses_requested_today, daily_analysis_cap
from py_db.scout_matching import (
    analyses_created_for_scout_run,
    lexical_similarity,
    scout_max_analyses_per_run,
)
from py_db.scout_rollup import roll_up_scout_run
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .sqs_client import ANALYSIS_INTAKE_QUEUE_URL, make_sqs_client


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _offer_text(offer: JobOffer) -> str:
    """Lexical-similarity input for pre-ranking: title + extracted
    description/requirements. Empty when the offer carries none of these —
    `lexical_similarity` scores an empty text 0.0 rather than raising."""
    data = offer.structuredData or {}
    parts = [offer.title or "", data.get("description") or ""]
    parts.extend(data.get("requirements") or [])
    return " ".join(parts)


@dataclass
class AnalysisFanoutResult:
    created_analysis_ids: list[str] = field(default_factory=list)
    quota_skipped_count: int = 0
    already_seen_count: int = 0
    run_limit_skipped_count: int = 0


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
    `ingestion_job.quotaSkippedCount`. Idempotent: re-running skips offers that
    already have an `Analysis` for this job, so an SQS redelivery does not
    double-create.

    For a Scout job (`ingestion_job.scoutRunId` set), candidates additionally
    pass cross-run dedup and the per-run ceiling (issue #55) before the daily
    cap; a manual job (`scoutRunId` is `None`) skips both gates entirely and
    keeps its original creation-order behaviour byte-for-byte.
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
        # Nothing to analyse (e.g. every discovered offer failed to scrape),
        # but a Scout run still needs its offersDiscovered/failedCount to
        # reflect the completed discovery (issue #54).
        await _roll_up_scout_run_if_any(session, ingestion_job)
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
        await _roll_up_scout_run_if_any(session, ingestion_job)
        return result

    # Scout attribution (issue #54): a SITE_SEARCH job fanned out by
    # `dispatch_scout_run` carries the ScoutRun id — resolve its Scout once and
    # stamp every Analysis this job produces with the denormalised `scoutId`,
    # so per-Scout finds/stats and cross-run dedup avoid a two-hop join. A
    # manual job has no `scoutRunId`, leaving `scoutId` NULL.
    scout_id: str | None = None
    if ingestion_job.scoutRunId:
        scout_run = await session.get(ScoutRun, ingestion_job.scoutRunId)
        scout_id = scout_run.scoutId if scout_run is not None else None

    if scout_id is not None:
        # Cross-run dedup (issue #55): this Scout may already have an
        # Analysis for one of these offers from an earlier run (or another
        # site's job in this same run, if two sites happened to return the
        # same URL) — never re-analyse it.
        already_seen_ids = set(
            (
                await session.scalars(
                    select(Analysis.jobOfferId).where(
                        Analysis.scoutId == scout_id,
                        Analysis.jobOfferId.in_(pending_offer_ids),
                    )
                )
            ).all()
        )
        result.already_seen_count = len(already_seen_ids)
        candidate_offer_ids = [oid for oid in pending_offer_ids if oid not in already_seen_ids]

        # Per-run ceiling (issue #55): rank the survivors by lexical
        # similarity to the Scout's base CV and only carry forward whatever
        # is left of SCOUT_MAX_ANALYSES_PER_RUN across the whole run so far.
        # `sorted` is stable, so equally-ranked offers keep their discovery
        # order (dict lookups below are O(1); no offer appears twice).
        cv_version = await session.get(CVVersion, ingestion_job.cvVersionId)
        cv_text = cv_version.markdownContent if cv_version is not None else None
        offer_rows = {
            offer.id: offer
            for offer in (
                await session.scalars(
                    select(JobOffer).where(JobOffer.id.in_(candidate_offer_ids))
                )
            ).all()
        }
        ranked_offer_ids = sorted(
            candidate_offer_ids,
            key=lambda oid: -lexical_similarity(_offer_text(offer_rows[oid]), cv_text),
        )
        run_budget = max(
            scout_max_analyses_per_run()
            - await analyses_created_for_scout_run(session, ingestion_job.scoutRunId),
            0,
        )
        pending_offer_ids = ranked_offer_ids[:run_budget]
        result.run_limit_skipped_count = len(ranked_offer_ids) - len(pending_offer_ids)
        ingestion_job.alreadySeenCount = result.already_seen_count
        ingestion_job.runLimitSkippedCount = result.run_limit_skipped_count
        ingestion_job.updatedAt = _now()

    # Same rule `POST /v1/analyses` enforces, via the shared helper (issue #33).
    cap = daily_analysis_cap()
    remaining = max(cap - await analyses_requested_today(session, ingestion_job.userId), 0)

    to_create = pending_offer_ids[:remaining]
    skipped = len(pending_offer_ids) - len(to_create)

    for job_offer_id in to_create:
        analysis = Analysis(
            id=str(uuid.uuid4()),
            userId=ingestion_job.userId,
            jobOfferId=job_offer_id,
            cvVersionId=ingestion_job.cvVersionId,
            ingestionJobId=ingestion_job.id,
            scoutId=scout_id,
            status=Analysisstatus.PENDING,
        )
        session.add(analysis)
        result.created_analysis_ids.append(analysis.id)

    if skipped:
        # Dedicated column (issue #33) rather than prose on errorMessage — the
        # Batch result view reads this to mark the quota-skipped offers, and
        # errorMessage stays reserved for actual failures.
        ingestion_job.quotaSkippedCount = skipped
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

    # Progressive roll-up (issue #54): discovery has run and this Scout run's
    # Analysis rows now exist, so recompute the ScoutRun's
    # offersDiscovered/offersAnalysed/relevantCount/failedCount. Each Analysis
    # completing later re-runs the roll-up from the analysis side.
    await _roll_up_scout_run_if_any(session, ingestion_job)

    return result


async def _roll_up_scout_run_if_any(session: AsyncSession, ingestion_job: IngestionJob) -> None:
    """Recompute the owning `ScoutRun`'s progressive counts when `ingestion_job`
    belongs to a Scout run; a no-op for a manual job (issue #54)."""
    if ingestion_job.scoutRunId:
        await roll_up_scout_run(session, ingestion_job.scoutRunId)
