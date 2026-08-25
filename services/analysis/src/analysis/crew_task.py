"""RunComparisonCrew Fargate task (PRD Section 10 steps 6-7, M5-T3).

The Fargate task that does the actual work behind the state machine's
`RunComparisonCrew` `waitForTaskToken` state: runs ComparisonAnalysisAgent
then RecommendationWriterAgent (M2-T6) for an Analysis, writes the
validated Section 8.6 JSON to
`s3://{bucket}/analysis-results/{analysisId}.json`, and calls
`SendTaskSuccess` with the S3 key so the state machine can proceed.
`Analysis.status` moves PENDING/QUEUED -> RUNNING_CREW (step 6) ->
AWAITING_RESULT (step 7).

Deliberately does NOT write `resultJSON`/`matchScore`/`status=COMPLETED` to
Postgres itself: PRD Section 10 step 9 designates `PersistResultLambda`
(M5-T4), triggered by the S3 `ObjectCreated` event, as the sole writer of
terminal Analysis state. That's the same "sole writer" boundary M2-T6's
`comparison_crew.run_analysis` doesn't have to respect (it's M2's
simplified, directly-persisted path, kept as-is for that milestone).

Provisioning a real Fargate task/ECS RunTask launch is deployment/infra
wiring, out of PRD scope (Section 4/15, no IaC) — same boundary already
drawn for the state machine's `ensure_state_machine` and the SQS trigger in
`intake_handler`. Locally and in tests, `handlers.run_comparison_crew_handler`
(the Lambda Step Functions invokes for this state) runs this task's logic on
a background thread, returning its own Lambda response immediately and
letting that thread call SendTaskSuccess/Failure once the work is done —
standing in for "launch a Fargate task that does this and reports back" the
same way `lambda_shim` stands in for real deployed Lambdas elsewhere in M5.
"""

import json
from datetime import UTC, datetime

from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvparsestatus,
    JobOffer,
    Jobofferextractionstatus,
)
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from sqlalchemy.ext.asyncio import AsyncSession

from .analysis_result import AnalysisResult
from .comparison_analysis_agent import ComparisonAnalysisError, run_comparison_analysis
from .llm_provider import LLMProvider, get_llm_provider
from .recommendation_writer_agent import RecommendationWriterError, run_recommendation_writer
from .s3_client import S3_BUCKET, analysis_result_key, make_s3_client
from .state_machine import make_sfn_client

logger = get_logger(__name__)

STAGE = "crew"


class CrewTaskError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def run_crew_task(
    session: AsyncSession,
    analysis_id: str,
    *,
    llm_provider: LLMProvider | None = None,
    s3_client=None,
    sfn_client=None,
    task_token: str | None = None,
) -> str:
    """Runs the crew, writes the result to S3, and (if `task_token` is given)
    reports back to Step Functions. Returns the S3 result key. Raises
    CrewTaskError on any failure, after transitioning Analysis to FAILED
    with a non-empty errorMessage and (if `task_token` is given) calling
    SendTaskFailure — never leaving the execution's task token unredeemed.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise CrewTaskError(f"Analysis {analysis_id} not found")

    log_stage_event(logger, stage=STAGE, status="STARTED", analysis_id=analysis_id)
    await record_pipeline_event(session, stage=STAGE, status="STARTED", analysis_id=analysis_id)

    analysis.status = Analysisstatus.RUNNING_CREW
    analysis.startedAt = _now()
    await session.commit()

    sfn = sfn_client
    if sfn is None and task_token:
        sfn = make_sfn_client()

    async def _fail(message: str) -> None:
        analysis.status = Analysisstatus.FAILED
        analysis.errorMessage = message
        await session.commit()
        log_stage_event(
            logger, stage=STAGE, status="FAILED", analysis_id=analysis_id, message=message
        )
        await record_pipeline_event(
            session, stage=STAGE, status="FAILED", message=message, analysis_id=analysis_id
        )
        if task_token and sfn is not None:
            sfn.send_task_failure(taskToken=task_token, error="CrewTaskError", cause=message)

    job_offer = await session.get(JobOffer, analysis.jobOfferId)
    if (
        job_offer is None
        or job_offer.extractionStatus != Jobofferextractionstatus.READY
        or not job_offer.structuredData
    ):
        message = f"JobOffer {analysis.jobOfferId} is not READY with structuredData"
        await _fail(message)
        raise CrewTaskError(message)

    cv_version = await session.get(CVVersion, analysis.cvVersionId)
    if (
        cv_version is None
        or cv_version.parseStatus != Cvparsestatus.PARSED
        or not cv_version.structuredData
    ):
        message = f"CVVersion {analysis.cvVersionId} is not PARSED with structuredData"
        await _fail(message)
        raise CrewTaskError(message)

    provider = llm_provider or get_llm_provider()

    try:
        comparison = run_comparison_analysis(
            job_offer.structuredData, cv_version.structuredData, llm_provider=provider
        )
        recommendation = run_recommendation_writer(comparison, llm_provider=provider)
        result = AnalysisResult(
            match_score=comparison.match_score,
            matched_skills=comparison.matched_skills,
            missing_skills=comparison.missing_skills,
            strengths=comparison.strengths,
            weaknesses=comparison.weaknesses,
            improvement_suggestions=recommendation.improvement_suggestions,
            summary=recommendation.summary,
            generated_at=_now().isoformat() + "Z",
            model_used=getattr(provider, "model", "unknown"),
            job_offer_id=analysis.jobOfferId,
            cv_version_id=analysis.cvVersionId,
        )
    except (ComparisonAnalysisError, RecommendationWriterError) as exc:
        message = str(exc)
        await _fail(message)
        raise CrewTaskError(message) from exc

    s3 = s3_client or make_s3_client()
    key = analysis_result_key(analysis_id)
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=result.model_dump_json().encode("utf-8"),
        ContentType="application/json",
    )

    analysis.status = Analysisstatus.AWAITING_RESULT
    analysis.s3ResultKey = key
    analysis.errorMessage = None
    await session.commit()

    log_stage_event(logger, stage=STAGE, status="SUCCEEDED", analysis_id=analysis_id, s3_result_key=key)
    await record_pipeline_event(session, stage=STAGE, status="SUCCEEDED", analysis_id=analysis_id)

    if task_token and sfn is not None:
        sfn.send_task_success(
            taskToken=task_token,
            output=json.dumps({"analysisId": analysis_id, "s3ResultKey": key}),
        )

    return key
