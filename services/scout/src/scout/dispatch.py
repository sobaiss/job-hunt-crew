"""`dispatch_scout_run` — the Scout context's one orchestration seam (issue #54).

Given a `ScoutRun` id it:

1. resolves the run and its `Scout`;
2. no-ops if the Scout's previous run is still `RUNNING` (skip-on-overlap) or
   the Scout is not `ACTIVE`;
3. marks the run `RUNNING`;
4. for each targeted site key, resolves the `SiteConfig`: a missing or
   disabled site is counted `siteUnavailableCount` and skipped, an enabled one
   gets a `SITE_SEARCH` `IngestionJob` (carrying the Scout's `cvVersionId`,
   `filters`, and this `scoutRunId`) enqueued on `ingestion-intake`;
5. rolls the run up to `COMPLETED` (every targeted site queried),
   `PARTIALLY_COMPLETED` (some site unavailable) or `FAILED` (every targeted
   site unavailable), and stamps `Scout.lastRunAt`.

The discover/scrape/extract/analyse pipeline then runs unchanged off the
`ingestion-intake` messages. Progressive roll-up of `offersDiscovered` /
`offersAnalysed` / `relevantCount` as those complete is issue #55/#56.
"""

import json
import uuid
from datetime import UTC, datetime

from py_db.models import (
    IngestionJob,
    Ingestionjobstatus,
    Ingestionmode,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    SiteConfig,
    Siteconfigsitekey,
)
from py_db.structured_logging import get_logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .sqs_client import INGESTION_INTAKE_QUEUE_URL, make_sqs_client

logger = get_logger(__name__)

# Both IngestionJob and Scout are enqueued at the shared per-run default.
SCOUT_INGESTION_MAX_OFFERS = 25


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE; strip tzinfo after UTC.
    return datetime.now(UTC).replace(tzinfo=None)


class ScoutRunError(Exception):
    pass


async def _has_other_running_run(session: AsyncSession, scout_id: str, this_run_id: str) -> bool:
    stmt = select(ScoutRun.id).where(
        ScoutRun.scoutId == scout_id,
        ScoutRun.status == Scoutrunstatus.RUNNING,
        ScoutRun.id != this_run_id,
    )
    return (await session.scalars(stmt)).first() is not None


async def dispatch_scout_run(
    session: AsyncSession,
    scout_run_id: str,
    *,
    sqs_client=None,
) -> ScoutRun:
    """Load `scout_run_id`, fan out one `SITE_SEARCH` `IngestionJob` per
    targeted enabled site, and roll the run up. Raises `ScoutRunError` if the
    run row is missing.
    """
    scout_run = await session.get(ScoutRun, scout_run_id)
    if scout_run is None:
        raise ScoutRunError(f"ScoutRun {scout_run_id} not found")

    scout = await session.get(Scout, scout_run.scoutId)
    if scout is None:
        raise ScoutRunError(f"ScoutRun {scout_run_id} points at missing Scout {scout_run.scoutId}")

    # Skip-on-overlap: a run started while the previous one is still RUNNING is
    # a no-op — leave this row untouched (PENDING) for the operator to see.
    if await _has_other_running_run(session, scout.id, scout_run.id):
        logger.info(
            "scout_run.skipped_overlap",
            extra={"fields": {"scoutId": scout.id, "scoutRunId": scout_run.id}},
        )
        return scout_run

    if scout.status != Scoutstatus.ACTIVE:
        scout_run.status = Scoutrunstatus.FAILED
        scout_run.errorMessage = f"Scout is {scout.status.value}, not ACTIVE"
        scout_run.startedAt = scout_run.startedAt or _now()
        scout_run.finishedAt = _now()
        await session.commit()
        await session.refresh(scout_run)
        return scout_run

    scout_run.status = Scoutrunstatus.RUNNING
    scout_run.startedAt = _now()
    await session.commit()

    target_keys = list(scout.targetSiteKeys or [])
    client = sqs_client or make_sqs_client()

    sites_queried = 0
    site_unavailable = 0
    enqueued_ids: list[str] = []

    for key in target_keys:
        try:
            site_key = Siteconfigsitekey(key)
        except ValueError:
            site_unavailable += 1
            continue

        site_config = (
            await session.scalars(select(SiteConfig).where(SiteConfig.siteKey == site_key))
        ).first()
        if site_config is None or not site_config.enabled:
            site_unavailable += 1
            continue

        ingestion_job = IngestionJob(
            id=str(uuid.uuid4()),
            userId=scout.userId,
            mode=Ingestionmode.SITE_SEARCH,
            cvVersionId=scout.cvVersionId,
            siteConfigId=site_config.id,
            scoutRunId=scout_run.id,
            filters=dict(scout.filters or {}),
            maxOffers=SCOUT_INGESTION_MAX_OFFERS,
            status=Ingestionjobstatus.PENDING,
            updatedAt=_now(),
        )
        session.add(ingestion_job)
        enqueued_ids.append(ingestion_job.id)
        sites_queried += 1

    await session.commit()

    for ingestion_job_id in enqueued_ids:
        client.send_message(
            QueueUrl=INGESTION_INTAKE_QUEUE_URL,
            MessageBody=json.dumps({"ingestionJobId": ingestion_job_id}),
        )

    scout_run.sitesQueried = sites_queried
    scout_run.siteUnavailableCount = site_unavailable
    if sites_queried == 0:
        scout_run.status = Scoutrunstatus.FAILED
        scout_run.errorMessage = "Every targeted site is unavailable"
    elif site_unavailable > 0:
        scout_run.status = Scoutrunstatus.PARTIALLY_COMPLETED
    else:
        scout_run.status = Scoutrunstatus.COMPLETED
    scout_run.finishedAt = _now()

    scout.lastRunAt = _now()
    await session.commit()
    await session.refresh(scout_run)
    return scout_run
