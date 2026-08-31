"""CV Conversion — build a CVVersion's Markdown rendition (issue #16, slice 1).

Replaces `cv_extraction_agent.extract_cv` on the CV path: every CVVersion now
carries one canonical Markdown document (`CVVersion.markdownContent`) that the
comparison reads directly, instead of the lossy `structuredData` JSON summary.
See docs/adr/0001-cv-matching-uses-markdown-rendition.md.

This slice handles the MD / TXT case only: the uploaded file's UTF-8 text *is*
the Markdown rendition, so there is no LLM call. The PDF and DOCX branches
(mechanical text/HTML extraction plus one LLM normalisation pass) land in
slices 2 and 3; until then `convert_cv` raises for those types.
"""

from datetime import UTC, datetime

from py_db.models import CVVersion, Cvconversionstatus, Cvfiletype
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from sqlalchemy.ext.asyncio import AsyncSession

from .llm_provider import LLMProvider
from .s3_client import S3_BUCKET, make_s3_client

logger = get_logger(__name__)

STAGE = "convert"

# Formats whose uploaded bytes are already the Markdown rendition (decode only).
_TEXT_FILE_TYPES = {Cvfiletype.MD, Cvfiletype.TXT}


class CVConversionError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def convert_cv(
    session: AsyncSession,
    cv_version_id: str,
    *,
    llm_provider: LLMProvider | None = None,
    analysis_id: str | None = None,
) -> CVVersion:
    """Produces CVVersion.markdownContent from the uploaded file at
    CVVersion.fileKey, transitioning conversionStatus PENDING -> CONVERTING ->
    CONVERTED and emitting a `convert`-stage PipelineEvent (M6-T3). `analysis_id`
    is optional context (this runs from AnalysisWorkflow's EnsureCVConverted
    step, or standalone via the manual convert trigger) used only to tag the
    observability rows this emits.

    This slice: MD / TXT only — the file's decoded UTF-8 text is the rendition,
    no LLM call. PDF / DOCX raise here until slices 2 / 3 add their branches.
    """
    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None:
        raise CVConversionError(f"CVVersion {cv_version_id} not found")

    log_stage_event(
        logger, stage=STAGE, status="STARTED", cv_version_id=cv_version_id, analysis_id=analysis_id
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="STARTED",
        message=f"cv_version_id={cv_version_id}",
        analysis_id=analysis_id,
    )

    cv_version.conversionStatus = Cvconversionstatus.CONVERTING
    cv_version.updatedAt = _now()
    await session.commit()

    if cv_version.fileType not in _TEXT_FILE_TYPES:
        message = (
            f"convert_cv does not yet handle {cv_version.fileType.value} "
            f"(cv_version_id={cv_version_id})"
        )
        cv_version.conversionStatus = Cvconversionstatus.FAILED
        cv_version.conversionError = message
        cv_version.updatedAt = _now()
        await session.commit()
        log_stage_event(
            logger,
            stage=STAGE,
            status="FAILED",
            cv_version_id=cv_version_id,
            analysis_id=analysis_id,
            message=message,
        )
        await record_pipeline_event(
            session, stage=STAGE, status="FAILED", message=message, analysis_id=analysis_id
        )
        raise CVConversionError(message)

    s3 = make_s3_client()
    obj = s3.get_object(Bucket=S3_BUCKET, Key=cv_version.fileKey)
    file_bytes = obj["Body"].read()
    # Lenient UTF-8: a stray non-UTF-8 byte in an otherwise fine text CV should
    # not fail Conversion.
    markdown = file_bytes.decode("utf-8", errors="replace")

    cv_version.markdownContent = markdown
    cv_version.conversionStatus = Cvconversionstatus.CONVERTED
    cv_version.conversionError = None
    cv_version.updatedAt = _now()
    await session.commit()

    log_stage_event(
        logger, stage=STAGE, status="SUCCEEDED", cv_version_id=cv_version_id, analysis_id=analysis_id
    )
    await record_pipeline_event(
        session,
        stage=STAGE,
        status="SUCCEEDED",
        message=f"cv_version_id={cv_version_id}",
        analysis_id=analysis_id,
    )
    return cv_version
