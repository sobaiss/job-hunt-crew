"""AnalysisWorkflow Lambda handlers (PRD Section 10 steps 4-6, M5-T2).

Thin, synchronous Lambda entrypoints wrapping the existing async pipeline
functions (M2-T4's extract_job_offer, M2-T5's extract_cv). Each handler's
input/output is `{"analysisId": "..."}` so Step Functions can chain them
via the state machine's `$.analysisId` path (analysis_workflow.asl.json).
"""

import asyncio

from py_db.models import Analysis, CVVersion, Cvparsestatus, JobOffer, Jobofferextractionstatus
from py_db.session import make_engine, make_session_factory
from sqlalchemy.ext.asyncio import AsyncSession

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


def run_comparison_crew_handler(event: dict, context=None) -> dict:
    """PRD Section 10 step 6's entrypoint for the `waitForTaskToken` Task.
    Its job is to hand `event["taskToken"]` off to the Fargate task that
    actually runs the CrewAI crew (SendTaskSuccess/Failure is called by that
    task, not this Lambda) — launching Fargate is M5-T3's explicit scope, so
    this is deliberately a stub for now. The state machine's RunComparisonCrew
    Task does not exit on this handler's return; it stays RUNNING until a
    SendTaskSuccess/SendTaskFailure call arrives for the given token.
    """
    return {"analysisId": event["analysisId"], "received": True}
