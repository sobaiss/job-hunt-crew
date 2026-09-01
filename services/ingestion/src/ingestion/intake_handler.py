"""SQS-triggered `ingestion-intake` worker (issue #27).

Consumes the `{"ingestionJobId": ...}` messages `POST /v1/ingestion-jobs`
enqueues (slice 2), loads the `IngestionJob` and dispatches by `mode`:
`SINGLE_URL` -> `run_single_url_ingestion`, `SITE_SEARCH` ->
`run_site_search_ingestion`. Parallel to
`analysis.intake_handler.handle_analysis_intake`.

`LISTING_URL` is a defined-but-unreachable mode (the API rejects it); a
message for one still marks the job `FAILED` rather than raising, so it is
not redelivered as a poison message.
"""

import asyncio
import json
from datetime import UTC, datetime

import httpx
from analysis.llm_provider import LLMProvider
from py_db.models import IngestionJob, Ingestionjobstatus, Ingestionmode, SiteConfig
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy.ext.asyncio import AsyncSession

from .analysis_fanout import create_analyses_for_ready_offers
from .single_url_pipeline import run_single_url_ingestion
from .site_search_pipeline import run_site_search_ingestion

logger = get_logger(__name__)


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE; strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


class IngestionIntakeError(Exception):
    pass


async def dispatch_ingestion_job(
    session: AsyncSession,
    ingestion_job_id: str,
    *,
    http_client: httpx.AsyncClient | None = None,
    llm_provider: LLMProvider | None = None,
    sqs_client=None,
) -> IngestionJob:
    """Loads `ingestion_job_id`, marks it `RUNNING`, hands it to the per-mode
    pipeline entrypoint, then runs the shared end-of-fan-out step that
    creates one `Analysis` per `READY` `JobOffer` and enqueues it on
    `analysis-intake`. Raises `IngestionIntakeError` if the row is missing or
    a `SITE_SEARCH` job has no resolvable `SiteConfig`.
    """
    ingestion_job = await session.get(IngestionJob, ingestion_job_id)
    if ingestion_job is None:
        raise IngestionIntakeError(f"IngestionJob {ingestion_job_id} not found")

    ingestion_job.status = Ingestionjobstatus.RUNNING
    ingestion_job.updatedAt = _now()
    await session.commit()

    if ingestion_job.mode == Ingestionmode.SINGLE_URL:
        await run_single_url_ingestion(
            session, ingestion_job, http_client=http_client, llm_provider=llm_provider
        )
    elif ingestion_job.mode == Ingestionmode.SITE_SEARCH:
        site_config = (
            await session.get(SiteConfig, ingestion_job.siteConfigId)
            if ingestion_job.siteConfigId
            else None
        )
        if site_config is None:
            raise IngestionIntakeError(
                f"IngestionJob {ingestion_job_id} has no resolvable SiteConfig "
                f"(siteConfigId={ingestion_job.siteConfigId!r})"
            )
        await run_site_search_ingestion(
            session,
            ingestion_job,
            site_config,
            ingestion_job.filters or {},
            http_client=http_client,
            llm_provider=llm_provider,
        )
    else:
        ingestion_job.status = Ingestionjobstatus.FAILED
        ingestion_job.errorMessage = f"Unsupported ingestion mode {ingestion_job.mode.value}"
        ingestion_job.updatedAt = _now()
        await session.commit()
        await session.refresh(ingestion_job)
        return ingestion_job

    ingestion_job = await session.get(IngestionJob, ingestion_job_id)
    await create_analyses_for_ready_offers(session, ingestion_job, sqs_client=sqs_client)
    return await session.get(IngestionJob, ingestion_job_id)


def handle_ingestion_intake(event: dict, context=None) -> None:
    """SQS event-source-mapping Lambda entrypoint: `event["Records"]` is a
    batch of `ingestion-intake` messages, each with a JSON body
    `{"ingestionJobId": "..."}`. A per-record failure is logged and
    swallowed (the pipeline already persists `FAILED` on the row) so one bad
    message doesn't block the batch or redeliver forever.
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    body = json.loads(record["body"])
                    try:
                        await dispatch_ingestion_job(session, body["ingestionJobId"])
                    except Exception:
                        logger.exception(
                            "ingestion_intake_failed for ingestion_job_id=%s",
                            body.get("ingestionJobId"),
                        )
        finally:
            await engine.dispose()

    asyncio.run(_run())
