"""CV Conversion — build a CVVersion's Markdown rendition (issue #16).

Replaces `cv_extraction_agent.extract_cv` on the CV path: every CVVersion now
carries one canonical Markdown document (`CVVersion.markdownContent`) that the
comparison reads directly, instead of the lossy `structuredData` JSON summary.
See docs/adr/0001-cv-matching-uses-markdown-rendition.md.

Per source format:
- MD / TXT (slice 1): the uploaded file's UTF-8 text *is* the rendition, so
  there is no LLM call.
- PDF (slice 2, issue #17): `pypdf` pulls the text, then a single LLM
  normalisation pass turns it into clean, faithful Markdown. A PDF with almost
  no extractable text (a scanned/image PDF) fails Conversion immediately with a
  message naming the likely cause — no OCR, no retry.
- DOCX (slice 3): still raises here until its branch lands.
"""

import io
from datetime import UTC, datetime

from py_db.models import CVVersion, Cvconversionstatus, Cvfiletype
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import AsyncSession

from .llm_provider import LLMProvider, get_llm_provider
from .s3_client import S3_BUCKET, make_s3_client

logger = get_logger(__name__)

STAGE = "convert"

# Formats whose uploaded bytes are already the Markdown rendition (decode only).
_TEXT_FILE_TYPES = {Cvfiletype.MD, Cvfiletype.TXT}

# PDF normalisation-pass tuning.
MAX_TEXT_CHARS = 20000
MAX_ATTEMPTS = 3
# Fewer than this many non-whitespace characters out of `pypdf` means the PDF
# has no usable text layer (scanned/image-only) — fail fast, no LLM, no OCR.
MIN_EXTRACTED_CHARS = 50
# Higher than llm_provider's shared 4096 default: a faithful Markdown rendition
# of a multi-page CV runs long and must not be truncated mid-document.
NORMALISATION_MAX_TOKENS = 8192

NORMALISATION_SYSTEM_PROMPT = (
    "You are given the raw text extracted from a candidate's CV/resume. "
    "Reproduce it faithfully as a single clean Markdown document: use section "
    "headings, bullet lists for roles, skills and achievements, and keep every "
    "date, employer, title and detail. Do not summarise, drop, reorder or "
    "invent anything, and add no commentary or preamble. Respond with ONLY the "
    "Markdown document."
)


class CVConversionError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _extract_pdf_text(file_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(file_bytes))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


async def _emit(
    session: AsyncSession, *, status: str, message: str, cv_version_id: str, analysis_id: str | None
) -> None:
    log_stage_event(
        logger,
        stage=STAGE,
        status=status,
        cv_version_id=cv_version_id,
        analysis_id=analysis_id,
        message=message,
    )
    await record_pipeline_event(
        session, stage=STAGE, status=status, message=message, analysis_id=analysis_id
    )


async def _mark_failed(
    session: AsyncSession, cv_version: CVVersion, message: str, analysis_id: str | None
) -> None:
    cv_version.conversionStatus = Cvconversionstatus.FAILED
    cv_version.conversionError = message
    cv_version.updatedAt = _now()
    await session.commit()
    await _emit(
        session,
        status="FAILED",
        message=message,
        cv_version_id=cv_version.id,
        analysis_id=analysis_id,
    )
    raise CVConversionError(message)


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

    MD / TXT: the file's decoded UTF-8 text is the rendition, no LLM call.
    PDF: `pypdf` text extraction, then one LLM normalisation pass (up to
    MAX_ATTEMPTS on an empty/erroring response); a PDF with under
    MIN_EXTRACTED_CHARS of text goes straight to FAILED with a cause message.
    DOCX raises here until slice 3.
    """
    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None:
        raise CVConversionError(f"CVVersion {cv_version_id} not found")

    await _emit(
        session,
        status="STARTED",
        message=f"cv_version_id={cv_version_id}",
        cv_version_id=cv_version_id,
        analysis_id=analysis_id,
    )

    cv_version.conversionStatus = Cvconversionstatus.CONVERTING
    cv_version.updatedAt = _now()
    await session.commit()

    s3 = make_s3_client()
    obj = s3.get_object(Bucket=S3_BUCKET, Key=cv_version.fileKey)
    file_bytes = obj["Body"].read()

    if cv_version.fileType in _TEXT_FILE_TYPES:
        # Lenient UTF-8: a stray non-UTF-8 byte in an otherwise fine text CV
        # should not fail Conversion.
        markdown = file_bytes.decode("utf-8", errors="replace")
    elif cv_version.fileType == Cvfiletype.PDF:
        markdown = await _convert_pdf(
            session, cv_version, file_bytes, llm_provider=llm_provider, analysis_id=analysis_id
        )
    else:
        await _mark_failed(
            session,
            cv_version,
            f"convert_cv does not yet handle {cv_version.fileType.value} "
            f"(cv_version_id={cv_version_id})",
            analysis_id,
        )

    cv_version.markdownContent = markdown
    cv_version.conversionStatus = Cvconversionstatus.CONVERTED
    cv_version.conversionError = None
    cv_version.updatedAt = _now()
    await session.commit()

    await _emit(
        session,
        status="SUCCEEDED",
        message=f"cv_version_id={cv_version_id}",
        cv_version_id=cv_version_id,
        analysis_id=analysis_id,
    )
    return cv_version


async def _convert_pdf(
    session: AsyncSession,
    cv_version: CVVersion,
    file_bytes: bytes,
    *,
    llm_provider: LLMProvider | None,
    analysis_id: str | None,
) -> str:
    """PDF branch: mechanical text extraction, then one LLM normalisation pass.
    Returns the Markdown rendition, or raises CVConversionError (via _mark_failed)
    after recording the failure."""
    text = _extract_pdf_text(file_bytes)
    if sum(1 for ch in text if not ch.isspace()) < MIN_EXTRACTED_CHARS:
        await _mark_failed(
            session,
            cv_version,
            "no extractable text in this PDF — is it a scanned or image-only "
            f"document? (cv_version_id={cv_version.id})",
            analysis_id,
        )

    prompt = text[:MAX_TEXT_CHARS]
    provider = llm_provider or get_llm_provider()

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(
                system=NORMALISATION_SYSTEM_PROMPT,
                prompt=prompt,
                max_tokens=NORMALISATION_MAX_TOKENS,
            )
        except Exception as exc:  # noqa: BLE001 — any provider error is a retryable attempt
            last_error = exc
            continue
        if raw and raw.strip():
            return raw.strip()
        last_error = ValueError("empty LLM response")

    await _mark_failed(
        session,
        cv_version,
        f"CV Conversion failed for {cv_version.id} after {MAX_ATTEMPTS} "
        f"normalisation attempts: {last_error}",
        analysis_id,
    )
