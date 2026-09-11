"""Progressive roll-up of a `ScoutRun`'s per-offer counts (issue #54).

`dispatch_scout_run` (services/scout) sets a run's site-level columns
(`sitesQueried`, `siteUnavailableCount`, `status`) when it fans out, but the
per-offer columns — `offersDiscovered`, `offersAnalysed`, `relevantCount`,
`failedCount` — can only be known once the ingestion + analysis pipelines the
run kicked off have made progress. This module recomputes those four columns
from the run's `IngestionJob`s and their `Analysis` rows, and is called from
the two completion points that can move them:

- the ingestion fan-out (`ingestion.intake_handler.dispatch_ingestion_job`),
  once a Scout job's offers are discovered/scraped and its `Analysis` rows
  created;
- each terminal `Analysis` transition (`analysis.persist_analysis_result` on
  COMPLETED, `analysis.handlers.mark_analysis_failed` on FAILED).

`ScoutRun.status` is left to `dispatch_scout_run` — this only touches the four
count columns. Hand-written (not sqlacodegen output), like `quota.py` /
`pipeline_events.py`, so the ingestion and analysis contexts can share it
without either depending on `services/scout`.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Analysis, Analysisstatus, IngestionJob, Scout, ScoutRun


async def roll_up_scout_run(session: AsyncSession, scout_run_id: str) -> None:
    """Recompute `offersDiscovered` / `offersAnalysed` / `relevantCount` /
    `failedCount` on `scout_run_id` from its `IngestionJob`s and their
    `Analysis` rows, then commit. A no-op when the run row is gone.

    - `offersDiscovered`: sum of `IngestionJob.discoveredCount` over the run's
      jobs (every offer the run's site searches turned up).
    - `offersAnalysed`: `Analysis` rows for those jobs that reached `COMPLETED`.
    - `relevantCount`: those whose `matchScore >= Scout.matchThreshold`.
    - `failedCount`: offers that failed to scrape/extract (sum of
      `IngestionJob.failedCount`) plus `Analysis` rows that reached `FAILED`.
    """
    scout_run = await session.get(ScoutRun, scout_run_id)
    if scout_run is None:
        return

    scout = await session.get(Scout, scout_run.scoutId)
    threshold = scout.matchThreshold if scout is not None else 0

    job_rows = (
        await session.execute(
            select(
                IngestionJob.id,
                IngestionJob.discoveredCount,
                IngestionJob.failedCount,
            ).where(IngestionJob.scoutRunId == scout_run_id)
        )
    ).all()
    job_ids = [row.id for row in job_rows]
    offers_discovered = sum(row.discoveredCount or 0 for row in job_rows)
    offers_failed = sum(row.failedCount or 0 for row in job_rows)

    offers_analysed = 0
    relevant_count = 0
    analyses_failed = 0
    if job_ids:
        analysis_rows = (
            await session.execute(
                select(Analysis.status, Analysis.matchScore).where(
                    Analysis.ingestionJobId.in_(job_ids)
                )
            )
        ).all()
        for status, match_score in analysis_rows:
            if status == Analysisstatus.COMPLETED:
                offers_analysed += 1
                if match_score is not None and match_score >= threshold:
                    relevant_count += 1
            elif status == Analysisstatus.FAILED:
                analyses_failed += 1

    scout_run.offersDiscovered = offers_discovered
    scout_run.offersAnalysed = offers_analysed
    scout_run.relevantCount = relevant_count
    scout_run.failedCount = offers_failed + analyses_failed
    await session.commit()


async def roll_up_scout_run_for_analysis(session: AsyncSession, analysis_id: str) -> None:
    """Roll up the `ScoutRun` that owns `analysis_id`, if any. A no-op for a
    manual `Analysis` (no `ingestionJobId`, or its job carries no
    `scoutRunId`)."""
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None or analysis.ingestionJobId is None:
        return
    ingestion_job = await session.get(IngestionJob, analysis.ingestionJobId)
    if ingestion_job is None or ingestion_job.scoutRunId is None:
        return
    await roll_up_scout_run(session, ingestion_job.scoutRunId)
