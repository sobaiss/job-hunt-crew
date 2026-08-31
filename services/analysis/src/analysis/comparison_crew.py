"""Comparison crew orchestration (PRD Section 10 step 6, M2-T6).

Runs ComparisonAnalysisAgent then RecommendationWriterAgent for a fixture
(JobOffer, CVVersion) pair and persists the combined, Pydantic-validated
Section 8.6 result to Analysis.resultJSON. This is M2's simplified,
directly-persisted pipeline (no S3 write / Step Functions / SQS — that's
M5's full async hardening); it writes straight to Postgres via SQLAlchemy,
consistent with M2-T2..T5's direct-write precedent.
"""

from datetime import UTC, datetime

from py_db.models import Analysis, Analysisstatus, JobOffer, Jobofferextractionstatus
from sqlalchemy.ext.asyncio import AsyncSession

from .analysis_result import AnalysisResult
from .comparison_analysis_agent import ComparisonAnalysisError, run_comparison_analysis
from .cv_comparison_input import CVComparisonInputError, load_cv_markdown
from .llm_provider import LLMProvider, get_llm_provider
from .recommendation_writer_agent import RecommendationWriterError, run_recommendation_writer


class AnalysisError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def run_analysis(
    session: AsyncSession,
    analysis_id: str,
    *,
    llm_provider: LLMProvider | None = None,
) -> Analysis:
    """Runs the ComparisonAnalysisAgent + RecommendationWriterAgent crew for
    Analysis.id, transitioning status PENDING -> RUNNING_CREW -> COMPLETED.
    Requires the linked JobOffer to already carry structuredData
    (extractionStatus=READY, per M2-T4) and the CVVersion to be CONVERTED
    with a Markdown rendition. On any
    failure (missing prerequisites or malformed/failed LLM output after
    bounded retries), transitions to FAILED with errorMessage set and never
    writes a partial resultJSON.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise AnalysisError(f"Analysis {analysis_id} not found")

    analysis.status = Analysisstatus.RUNNING_CREW
    analysis.startedAt = _now()
    await session.commit()

    job_offer = await session.get(JobOffer, analysis.jobOfferId)

    if (
        job_offer is None
        or job_offer.extractionStatus != Jobofferextractionstatus.READY
        or not job_offer.structuredData
    ):
        message = f"JobOffer {analysis.jobOfferId} is not READY with structuredData"
        analysis.status = Analysisstatus.FAILED
        analysis.errorMessage = message
        await session.commit()
        raise AnalysisError(message)

    try:
        cv_markdown = await load_cv_markdown(session, analysis.cvVersionId)
    except CVComparisonInputError as exc:
        message = str(exc)
        analysis.status = Analysisstatus.FAILED
        analysis.errorMessage = message
        await session.commit()
        raise AnalysisError(message) from exc

    provider = llm_provider or get_llm_provider()

    try:
        comparison = run_comparison_analysis(
            job_offer.structuredData,
            cv_markdown,
            llm_provider=provider,
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
        analysis.status = Analysisstatus.FAILED
        analysis.errorMessage = message
        await session.commit()
        raise AnalysisError(message) from exc

    analysis.resultJSON = result.model_dump(mode="json")
    analysis.matchScore = result.match_score
    analysis.status = Analysisstatus.COMPLETED
    analysis.errorMessage = None
    analysis.completedAt = _now()
    await session.commit()
    return analysis
