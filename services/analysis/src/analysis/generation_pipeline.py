"""In-process GenerationWorkflow runner for local dev (no Step Functions).

Production generation runs a `GeneratedDocument` through a dedicated
GenerationWorkflow, separate from AnalysisWorkflow (issue #58 / docs/adr/0004,
a future slice), triggered by a `generation-intake` SQS message. Reproducing
that shape locally needs the same `stepfunctions-local` infrastructure
`AnalysisWorkflow` would (see `local_pipeline`'s module docstring for why
that isn't wired up for dev). This module runs the whole pipeline in-process
instead — the same simplification `comparison_crew.run_analysis` used for M2
— so a "Generate documents" click completes after `docker compose up` with no
extra host processes. `ingestion.local_worker` selects
`handle_generation_intake_local` for the `generation-intake` queue.
"""

import asyncio
import json
from datetime import UTC, datetime

from py_db.models import (
    Analysis,
    CVVersion,
    GeneratedDocument,
    Generateddocumentstatus,
    Generateddocumenttype,
    JobOffer,
)
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy.ext.asyncio import AsyncSession

from .cover_letter_writer_agent import CoverLetterWriterError, run_cover_letter_writer
from .cv_tailoring_agent import CvTailoringError, run_cv_tailoring
from .llm_provider import LLMProvider, get_llm_provider
from .s3_client import S3_BUCKET, generated_document_key, make_s3_client

logger = get_logger(__name__)


class GenerationPipelineError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _offer_language(job_offer: JobOffer, *, fallback: str) -> str:
    """The offer's language when its structured data carries one, else
    `fallback` (the candidate's Locale, per issue #58's AC). Detection here is
    a plain dict lookup, not language identification from free text — a
    deeper implementation is deferred, same boundary as the pre-rank's
    lexical-only similarity in slice 3 (#55)."""
    data = job_offer.structuredData or {}
    return data.get("language") or fallback


async def run_generation_pipeline(
    session: AsyncSession,
    generated_document_id: str,
    *,
    llm_provider: LLMProvider | None = None,
    s3_client=None,
    locale_fallback: str = "en",
) -> GeneratedDocument:
    """Runs one GeneratedDocument end to end in-process: loads its Analysis,
    JobOffer, and base CVVersion, runs the matching generation agent
    (CoverLetterWriterAgent for COVER_LETTER, CVTailoringAgent for
    TAILORED_CV), and writes the resulting Markdown to Postgres (canonical)
    and S3 (mirror), transitioning status PENDING -> GENERATING -> READY.

    On any failure the row is left in a terminal FAILED status with a
    non-empty errorMessage and no partial markdownContent. Raises
    GenerationPipelineError.
    """
    document = await session.get(GeneratedDocument, generated_document_id)
    if document is None:
        raise GenerationPipelineError(f"GeneratedDocument {generated_document_id} not found")

    document.status = Generateddocumentstatus.GENERATING
    document.updatedAt = _now()
    await session.commit()

    analysis = await session.get(Analysis, document.analysisId)
    job_offer = await session.get(JobOffer, document.jobOfferId)
    cv_version = await session.get(CVVersion, document.cvVersionId)

    if (
        analysis is None
        or job_offer is None
        or cv_version is None
        or not cv_version.markdownContent
    ):
        message = f"GeneratedDocument {generated_document_id} is missing a prerequisite row"
        document.status = Generateddocumentstatus.FAILED
        document.errorMessage = message
        document.updatedAt = _now()
        await session.commit()
        raise GenerationPipelineError(message)

    result = analysis.resultJSON or {}
    matched_skills = result.get("matched_skills", [])
    missing_skills = result.get("missing_skills", [])
    language = _offer_language(job_offer, fallback=locale_fallback)

    provider = llm_provider or get_llm_provider()

    try:
        if document.type == Generateddocumenttype.COVER_LETTER:
            markdown = run_cover_letter_writer(
                cv_markdown=cv_version.markdownContent,
                job_offer_structured_data=job_offer.structuredData or {},
                matched_skills=matched_skills,
                missing_skills=missing_skills,
                language=language,
                llm_provider=provider,
            )
        else:
            markdown = run_cv_tailoring(
                cv_markdown=cv_version.markdownContent,
                job_offer_structured_data=job_offer.structuredData or {},
                matched_skills=matched_skills,
                missing_skills=missing_skills,
                language=language,
                llm_provider=provider,
            )
    except (CoverLetterWriterError, CvTailoringError) as exc:
        message = str(exc)
        document.status = Generateddocumentstatus.FAILED
        document.errorMessage = message
        document.updatedAt = _now()
        await session.commit()
        raise GenerationPipelineError(message) from exc

    s3 = s3_client or make_s3_client()
    key = generated_document_key(analysis.userId, document.analysisId, document.type.value)
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=markdown.encode("utf-8"),
        ContentType="text/markdown",
    )

    document.markdownContent = markdown
    document.s3Key = key
    document.status = Generateddocumentstatus.READY
    document.errorMessage = None
    document.updatedAt = _now()
    await session.commit()
    return document


def handle_generation_intake_local(event: dict, context=None) -> None:
    """SQS event-source-mapping entrypoint `ingestion.local_worker` uses for
    the `generation-intake` queue. `event["Records"]` is a batch of messages,
    each body `{"generatedDocumentId": "..."}` (per services/api's
    `POST /v1/analyses/{id}/generated-documents`).

    A pipeline failure is already persisted as `status=FAILED` on the row, so
    it is logged and swallowed here rather than left to redeliver as a
    poison message — the same contract
    `local_pipeline.handle_analysis_intake_local` uses.
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    body = json.loads(record["body"])
                    document_id = body["generatedDocumentId"]
                    try:
                        await run_generation_pipeline(session, document_id)
                    except GenerationPipelineError:
                        logger.exception(
                            "generation_pipeline_failed for generated_document_id=%s",
                            document_id,
                        )
        finally:
            await engine.dispose()

    asyncio.run(_run())
