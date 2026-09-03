"""In-process AnalysisWorkflow runner for local dev (no Step Functions).

Production runs an Analysis through the AnalysisWorkflow Step Functions state
machine: SQS intake -> EnsureCVConverted -> EnsureOfferExtracted ->
RunComparisonCrew (a `waitForTaskToken` Fargate task) -> an S3 `ObjectCreated`
event -> PersistResultLambda. Reproducing all of that locally needs
`stepfunctions-local`, the `lambda_shim` HTTP server, a registered state
machine, and an S3-event stand-in — so nothing drains `analysis-intake` after
a plain `docker compose up` and a `POST /v1/analyses` just parks a message in
ElasticMQ while the Analysis stays PENDING.

This module chains the exact same step functions in-process instead, the same
way `cv_conversion.handle_cv_conversion` runs Conversion in-process off its SQS
message rather than through the workflow. `ingestion.local_worker` selects
`handle_analysis_intake_local` for the `analysis-intake` queue when
`WORKER_ANALYSIS_MODE` is `local` (the default), so a `POST /v1/analyses`
completes after `docker compose up` with no extra host processes — matching how
the `cv-conversion` queue already works.

The steps and their failure contract are unchanged from the workflow: each of
`ensure_cv_converted`, `ensure_offer_extracted`, `run_crew_task` and
`persist_analysis_result` already lands its own subject in a terminal FAILED
state with a non-empty message on failure; this runner adds the top-level Catch
that the state machine's `Catch` blocks provide (routing to
`mark_analysis_failed`), so an error in a step that failed the CVVersion/JobOffer
row but not the Analysis — or anything unexpected — still leaves the Analysis
terminal rather than stuck.
"""

import asyncio
import json

from py_db.models import Analysis
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy.ext.asyncio import AsyncSession

from .crew_task import run_crew_task
from .handlers import ensure_cv_converted, ensure_offer_extracted, mark_analysis_failed
from .llm_provider import LLMProvider
from .persist_result_lambda import persist_analysis_result

logger = get_logger(__name__)


class LocalPipelineError(Exception):
    pass


async def run_analysis_pipeline(
    session: AsyncSession,
    analysis_id: str,
    *,
    llm_provider: LLMProvider | None = None,
) -> Analysis:
    """Runs one Analysis end to end in-process — EnsureCVConverted ->
    EnsureOfferExtracted -> the comparison crew (writing the result to S3) ->
    persist the terminal result — transitioning Analysis.status
    PENDING -> ... -> COMPLETED. The dev-local, no-Step-Functions equivalent of
    an AnalysisWorkflow execution.

    On any failure the Analysis is left in a terminal FAILED status with a
    non-empty errorMessage: the failing step sets a specific one where it can,
    and this runner's Catch (`mark_analysis_failed`, a no-op when a more
    specific reason is already recorded) covers everything else. Raises
    LocalPipelineError after recording the failure.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise LocalPipelineError(f"Analysis {analysis_id} not found")

    try:
        await ensure_cv_converted(session, analysis_id, llm_provider=llm_provider)
        await ensure_offer_extracted(session, analysis_id, llm_provider=llm_provider)
        await run_crew_task(session, analysis_id, llm_provider=llm_provider)
        return await persist_analysis_result(session, analysis_id)
    except Exception as exc:  # noqa: BLE001 - mirrors the state machine's `Catch: [States.ALL]`
        # A step may have left the session mid-transaction; drop it so
        # mark_analysis_failed re-reads the row (and any FAILED status a step
        # already committed) from the DB rather than the identity map.
        await session.rollback()
        await mark_analysis_failed(
            session,
            analysis_id,
            {"Error": type(exc).__name__, "Cause": str(exc)},
        )
        raise LocalPipelineError(str(exc)) from exc


def handle_analysis_intake_local(event: dict, context=None) -> None:
    """SQS event-source-mapping entrypoint `ingestion.local_worker` uses for the
    `analysis-intake` queue in place of `intake_handler.handle_analysis_intake`
    when `WORKER_ANALYSIS_MODE=local`. `event["Records"]` is a batch of
    `analysis-intake` messages, each body `{"analysisId": "..."}` (per
    services/api's `POST /v1/analyses`).

    A pipeline failure is already persisted as `status=FAILED` on the Analysis
    row by `run_analysis_pipeline`, so it is logged and swallowed here rather
    than left to redeliver as a poison message — the same contract
    `cv_conversion.handle_cv_conversion` uses.
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    body = json.loads(record["body"])
                    analysis_id = body["analysisId"]
                    try:
                        await run_analysis_pipeline(session, analysis_id)
                    except LocalPipelineError:
                        logger.exception(
                            "analysis_pipeline_failed for analysis_id=%s", analysis_id
                        )
        finally:
            await engine.dispose()

    asyncio.run(_run())
