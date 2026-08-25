"""AnalysisWorkflow Lambda handlers (PRD Section 10 steps 4-6, M5-T2).

Thin, synchronous Lambda entrypoints wrapping the existing async pipeline
functions (M2-T4's extract_job_offer, M2-T5's extract_cv). Each handler's
input/output is `{"analysisId": "..."}` so Step Functions can chain them
via the state machine's `$.analysisId` path (analysis_workflow.asl.json).
"""

import asyncio
import json
import threading

from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvparsestatus,
    JobOffer,
    Jobofferextractionstatus,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy.ext.asyncio import AsyncSession

from .crew_task import run_crew_task
from .cv_extraction_agent import extract_cv
from .job_offer_extraction_agent import extract_job_offer
from .llm_provider import LLMProvider


class HandlerError(Exception):
    pass


async def ensure_cv_parsed(
    session: AsyncSession, analysis_id: str, *, llm_provider: LLMProvider | None = None
) -> None:
    """PRD Section 10 step 4: checks CVVersion.parseStatus; if not PARSED,
    runs CVExtractionAgent. No-op if already PARSED (avoids re-parsing an
    unchanged CV, per PRD Section 8.2).
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise HandlerError(f"Analysis {analysis_id} not found")

    cv_version = await session.get(CVVersion, analysis.cvVersionId)
    if cv_version is None:
        raise HandlerError(f"CVVersion {analysis.cvVersionId} not found")

    if cv_version.parseStatus != Cvparsestatus.PARSED:
        await extract_cv(session, analysis.cvVersionId, llm_provider=llm_provider)


async def ensure_offer_extracted(
    session: AsyncSession, analysis_id: str, *, llm_provider: LLMProvider | None = None
) -> None:
    """PRD Section 10 step 5: same as ensure_cv_parsed, for JobOffer via
    JobOfferExtractionAgent. No-op if already READY.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise HandlerError(f"Analysis {analysis_id} not found")

    job_offer = await session.get(JobOffer, analysis.jobOfferId)
    if job_offer is None:
        raise HandlerError(f"JobOffer {analysis.jobOfferId} not found")

    if job_offer.extractionStatus != Jobofferextractionstatus.READY:
        await extract_job_offer(session, analysis.jobOfferId, llm_provider=llm_provider)


def ensure_cv_parsed_handler(event: dict, context=None) -> dict:
    analysis_id = event["analysisId"]

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                await ensure_cv_parsed(session, analysis_id)
        finally:
            await engine.dispose()

    asyncio.run(_run())
    return {"analysisId": analysis_id}


def ensure_offer_extracted_handler(event: dict, context=None) -> dict:
    analysis_id = event["analysisId"]

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                await ensure_offer_extracted(session, analysis_id)
        finally:
            await engine.dispose()

    asyncio.run(_run())
    return {"analysisId": analysis_id}


def _error_message_from_catch(error: dict) -> str:
    """PRD Section 10 step 10: every Catch block's error output is
    `{"Error": "<name>", "Cause": "<string>"}` (Step Functions' standard
    shape). `Cause` is either a plain string (e.g. crew_task's own
    SendTaskFailure `cause=`, already a clear message) or a JSON-encoded
    Lambda function-error payload (`{"errorMessage": ..., "errorType": ...}`,
    what a raised exception in ensure_cv_parsed_handler/
    ensure_offer_extracted_handler surfaces as, since AWS Lambda — and
    lambda_shim, standing in for it locally — reports handler errors that
    way). Unwrap the JSON case so errorMessage always carries the underlying
    reason, not a JSON blob.
    """
    cause = error.get("Cause") or ""
    try:
        parsed = json.loads(cause)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, dict) and parsed.get("errorMessage"):
        return str(parsed["errorMessage"])
    if cause:
        return cause
    return error.get("Error") or "AnalysisWorkflow step failed"


async def mark_analysis_failed(session: AsyncSession, analysis_id: str, error: dict) -> None:
    """PRD Section 10 step 10: the Catch target for every state in
    AnalysisWorkflow, guaranteeing that a step failure — after its Retry is
    exhausted — always lands the Analysis in a terminal FAILED status with a
    non-empty errorMessage, never leaving it stuck PENDING/QUEUED/RUNNING_CREW.
    A no-op if the Analysis already reached FAILED by some other path (e.g.
    crew_task's own SendTaskFailure branch already set a specific message
    before this Catch fires) so this never clobbers a more specific reason.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise HandlerError(f"Analysis {analysis_id} not found")

    if analysis.status == Analysisstatus.FAILED:
        return

    analysis.status = Analysisstatus.FAILED
    analysis.errorMessage = _error_message_from_catch(error)
    await session.commit()


def mark_analysis_failed_handler(event: dict, context=None) -> dict:
    analysis_id = event["analysisId"]
    error = event.get("error") or {}

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                await mark_analysis_failed(session, analysis_id, error)
        finally:
            await engine.dispose()

    asyncio.run(_run())
    return {"analysisId": analysis_id}


def run_comparison_crew_handler(event: dict, context=None) -> dict:
    """PRD Section 10 step 6's entrypoint for the `waitForTaskToken` Task.
    In a real deployment this Lambda's only job is to launch a Fargate task
    (`ecs:RunTask`) carrying `event["taskToken"]`, then return immediately —
    the Fargate task itself runs the crew and calls SendTaskSuccess/Failure
    once it's done, independently of and after this Lambda invocation has
    already returned (provisioning that launch is deployment/infra, out of
    this PRD's scope). Locally/in tests, with no real ECS to launch against,
    this handler starts M5-T3's `run_crew_task` logic on a background thread
    and returns right away, the same "run the real logic against a local
    stand-in" pattern `lambda_shim` uses for the other two handlers in this
    module — and, per Step Functions' `waitForTaskToken` contract, calling
    SendTaskSuccess/Failure only after this invocation's own response has
    already been sent (a synchronous call from within this handler is
    reliably ignored by Step Functions Local, unlike real AWS).
    """
    analysis_id = event["analysisId"]
    task_token = event.get("taskToken")

    def _run_in_background() -> None:
        async def _run() -> None:
            engine = make_engine()
            session_factory = make_session_factory(engine)
            try:
                async with session_factory() as session:
                    await run_crew_task(session, analysis_id, task_token=task_token)
            finally:
                await engine.dispose()

        try:
            asyncio.run(_run())
        except Exception:
            # run_crew_task already transitions Analysis to FAILED and calls
            # SendTaskFailure before raising; nothing left to report here,
            # and this thread has no caller to propagate the exception to.
            pass

    threading.Thread(target=_run_in_background, daemon=True).start()
    return {"analysisId": analysis_id, "launched": True}
