"""JobOfferExtractionAgent (PRD Section 8.3 step 5 / Section 10 step 5, M2-T4).

Structures a scraped JobOffer's raw HTML (stored by ingestion's scrape step,
M2-T2) into JobOffer.structuredData. Built on top of the LLM provider
abstraction (analysis.llm_provider) rather than importing an LLM SDK
directly, per that module's design intent.
"""

import json
from datetime import UTC, datetime

from py_db.models import JobOffer, Jobofferextractionstatus
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from .llm_provider import LLMProvider, get_llm_provider
from .s3_client import S3_BUCKET, make_s3_client

logger = get_logger(__name__)

STAGE = "extract"

MAX_ATTEMPTS = 3
MAX_HTML_CHARS = 20000

SYSTEM_PROMPT = (
    "You extract structured data from the raw HTML of a job posting. "
    "Respond with ONLY a single JSON object, no markdown fences, no commentary, "
    "matching this shape: "
    '{"description": string, "requirements": [string], "salary": string|null, '
    '"contractType": string|null, "remotePolicy": string|null, "seniority": string|null}.'
)


class JobOfferStructuredData(BaseModel):
    description: str
    requirements: list[str]
    salary: str | None = None
    contractType: str | None = None
    remotePolicy: str | None = None
    seniority: str | None = None


class ExtractionError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _parse_llm_output(raw: str) -> JobOfferStructuredData:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json") :]
    data = json.loads(text)
    return JobOfferStructuredData.model_validate(data)


async def extract_job_offer(
    session: AsyncSession,
    job_offer_id: str,
    *,
    llm_provider: LLMProvider | None = None,
    analysis_id: str | None = None,
    ingestion_job_id: str | None = None,
) -> JobOffer:
    """Structures JobOffer.rawContentKey's HTML into JobOffer.structuredData
    via the configured LLM provider, transitioning
    extractionStatus SCRAPED -> EXTRACTING -> READY. On repeated malformed/
    failed LLM output (up to MAX_ATTEMPTS), transitions to FAILED with
    errorMessage set instead (PRD 8.3 step 5: bounded retries, no unbounded
    retry loop). `analysis_id`/`ingestion_job_id` are optional context (this
    runs from both the AnalysisWorkflow's EnsureOfferExtracted step and the
    ingestion fan-out) used only to tag the PipelineEvent/log rows this
    emits (M6-T3).
    """
    job_offer = await session.get(JobOffer, job_offer_id)
    if job_offer is None:
        raise ExtractionError(f"JobOffer {job_offer_id} not found")
    if not job_offer.rawContentKey:
        raise ExtractionError(
            f"JobOffer {job_offer_id} has no rawContentKey; must be scraped first"
        )

    log_stage_event(
        logger,
        stage=STAGE,
        status="STARTED",
        job_offer_id=job_offer_id,
        analysis_id=analysis_id,
        ingestion_job_id=ingestion_job_id,
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="STARTED",
        message=f"job_offer_id={job_offer_id}",
        analysis_id=analysis_id,
        ingestion_job_id=ingestion_job_id,
    )

    job_offer.extractionStatus = Jobofferextractionstatus.EXTRACTING
    job_offer.updatedAt = _now()
    await session.commit()

    s3 = make_s3_client()
    obj = s3.get_object(Bucket=S3_BUCKET, Key=job_offer.rawContentKey)
    html = obj["Body"].read().decode("utf-8")[:MAX_HTML_CHARS]

    provider = llm_provider or get_llm_provider()

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(system=SYSTEM_PROMPT, prompt=html)
            structured = _parse_llm_output(raw)
        except (json.JSONDecodeError, ValidationError, TypeError) as exc:
            last_error = exc
            continue

        job_offer.structuredData = structured.model_dump()
        job_offer.extractionStatus = Jobofferextractionstatus.READY
        job_offer.errorMessage = None
        job_offer.updatedAt = _now()
        await session.commit()
        log_stage_event(
            logger,
            stage=STAGE,
            status="SUCCEEDED",
            job_offer_id=job_offer_id,
            analysis_id=analysis_id,
            ingestion_job_id=ingestion_job_id,
        )
        await record_pipeline_event(
            session,
            stage=STAGE,
            status="SUCCEEDED",
            message=f"job_offer_id={job_offer_id}",
            analysis_id=analysis_id,
            ingestion_job_id=ingestion_job_id,
        )
        return job_offer

    job_offer.extractionStatus = Jobofferextractionstatus.FAILED
    job_offer.errorMessage = f"Extraction failed after {MAX_ATTEMPTS} attempts: {last_error}"
    job_offer.updatedAt = _now()
    await session.commit()
    log_stage_event(
        logger,
        stage=STAGE,
        status="FAILED",
        job_offer_id=job_offer_id,
        analysis_id=analysis_id,
        ingestion_job_id=ingestion_job_id,
        message=job_offer.errorMessage,
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="FAILED",
        message=f"job_offer_id={job_offer_id}: {job_offer.errorMessage}",
        analysis_id=analysis_id,
        ingestion_job_id=ingestion_job_id,
    )
    raise ExtractionError(job_offer.errorMessage)
