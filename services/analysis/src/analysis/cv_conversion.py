"""CV Conversion — build a CVVersion's Markdown rendition (issue #16).

Every CVVersion carries one canonical Markdown document
(`CVVersion.markdownContent`) that the comparison reads directly. This
replaced the CV structured-data extraction path, retired in #21.
See docs/adr/0001-cv-matching-uses-markdown-rendition.md.

Per source format:
- MD / TXT (slice 1, then issue #167): the uploaded file's UTF-8 text is the
  rendition, run through one minimal-diff Redaction LLM pass that removes only
  the candidate's identity data and reproduces everything else verbatim.
- PDF (slice 2, issue #17): `pypdf` pulls the text, then a single LLM
  normalisation pass turns it into clean, faithful Markdown. A PDF with almost
  no extractable text (a scanned/image PDF) fails Conversion immediately with a
  message naming the likely cause — no OCR, no retry.
- DOCX (slice 3, issue #18): `mammoth` converts the document to semantic HTML,
  then the same single LLM normalisation pass (and bounded retry) as the PDF
  branch produces the Markdown.

Redaction (issues #166 and #167, docs/adr/0022): every format's rendition has
the candidate's identity data stripped — folded into the PDF/DOCX normalisation
pass, a dedicated minimal-diff pass for MD/TXT — then a deterministic safety
net (see cv_redaction.py) fails Conversion outright on any leftover. There is no
unredacted fallback for any format.

A PDF/DOCX CVVersion additionally gets a StyleProfile (`CVVersion.styleProfile`
/ `styleStatus`, issue #96) derived in the same pass — see style_profile.py
and docs/adr/0008-tailored-cv-visual-style-profile.md. An MD/TXT CVVersion
sets `styleStatus = NOT_APPLICABLE` and never calls style_profile.py.
"""

import asyncio
import io
import json
from datetime import UTC, datetime

import mammoth
from py_db.models import (
    CVVersion,
    Cvconversionstatus,
    Cvfiletype,
    Cvstylestatus,
    User,
)
from py_db.pipeline_events import record_pipeline_event
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger, log_stage_event
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import AsyncSession

from .cv_redaction import REDACTION_INSTRUCTIONS, find_identity_leaks
from .llm_provider import LLMProvider, get_llm_provider
from .s3_client import S3_BUCKET, make_s3_client
from .style_profile import StyleProfileError, build_style_profile

logger = get_logger(__name__)

STAGE = "convert"

# Formats whose uploaded bytes are already the Markdown rendition: no mechanical
# extraction and no StyleProfile, only the Redaction pass.
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

# Redaction (issue #166, docs/adr/0022) rides this same single pass — no extra
# LLM call — so the "reproduce faithfully" rule is scoped to what Redaction
# does not remove.
NORMALISATION_SYSTEM_PROMPT = (
    "You are given the raw text extracted from a candidate's CV/resume. "
    "Reproduce it faithfully as a single clean Markdown document: use section "
    "headings, bullet lists for roles, skills and achievements, and keep every "
    "date, employer, title and detail. Do not summarise, reorder or invent "
    "anything, and add no commentary or preamble. Do not drop anything except "
    "the identifying data described next. "
    + REDACTION_INSTRUCTIONS
    + " Respond with ONLY the Markdown document."
)

# MD/TXT Redaction pass (issue #167). Unlike the PDF/DOCX prompt above, this
# one forbids the very rewrite that prompt asks for: these formats' text is
# already the rendition, and docs/adr/0001's no-unnecessary-rewrite guarantee
# means the only permitted change is removing the flagged spans.
TEXT_REDACTION_SYSTEM_PROMPT = (
    "You are given a candidate's CV/resume as Markdown or plain text. "
    "Reproduce it exactly, character for character, with one exception: "
    "remove the identifying data described next. Make the smallest possible "
    "change — do not reformat, reorder, reword, translate, correct or "
    "summarise anything, keep every heading, list marker, line break and blank "
    "line as it is, and add no commentary or preamble. "
    + REDACTION_INSTRUCTIONS
    + " Respond with ONLY the resulting document."
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


def _extract_docx_html(file_bytes: bytes) -> str:
    # mammoth maps Word styles to semantic HTML (headings, lists, bold/italic),
    # which the normalisation pass turns into Markdown — richer than the flat
    # paragraph text python-docx would give us.
    return mammoth.convert_to_html(io.BytesIO(file_bytes)).value


async def _emit(
    session: AsyncSession,
    *,
    status: str,
    message: str,
    cv_version_id: str,
    analysis_id: str | None,
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


def _derive_style_profile(
    cv_version: CVVersion,
    file_bytes: bytes,
    markdown: str,
    *,
    llm_provider: LLMProvider | None,
) -> tuple[dict | None, Cvstylestatus]:
    """Best-effort StyleProfile derivation (issue #96), run only once
    `markdownContent`/`conversionStatus` have already succeeded. A failure
    here never touches `conversionStatus`/`conversionError`/`markdownContent`
    — it only downgrades `styleStatus` to FAILED, per docs/adr/0008: a
    presentation-layer extraction can't be allowed to block Conversion or
    matching.
    """
    if cv_version.fileType in _TEXT_FILE_TYPES:
        return None, Cvstylestatus.NOT_APPLICABLE

    try:
        profile = build_style_profile(
            file_bytes=file_bytes,
            file_type=cv_version.fileType,
            markdown=markdown,
            llm_provider=llm_provider or get_llm_provider(),
        )
    except StyleProfileError:
        logger.exception(
            "style_profile_extraction_failed for cv_version_id=%s", cv_version.id
        )
        return None, Cvstylestatus.FAILED

    return profile, Cvstylestatus.EXTRACTED


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

    MD / TXT: the file's decoded UTF-8 text goes through one minimal-diff
    Redaction LLM pass (issue #167) with the same bounded retry and safety net
    as PDF/DOCX; styleStatus is set to NOT_APPLICABLE, styleProfile stays null,
    and no StyleProfile LLM call is made.
    PDF: `pypdf` text extraction, then one LLM normalisation pass that also
    redacts identity data (up to MAX_ATTEMPTS on an empty/erroring response;
    a safety-net hit fails outright, see cv_redaction.py); a PDF with under
    MIN_EXTRACTED_CHARS of text goes straight to FAILED with a cause message.
    DOCX: `mammoth` docx -> HTML, then the same normalisation pass and bounded
    retry as the PDF branch.
    PDF/DOCX additionally derive a StyleProfile (issue #96, see
    style_profile.py) once markdownContent/conversionStatus have already
    succeeded — a StyleProfile failure sets styleStatus = FAILED without
    affecting conversionStatus/conversionError/markdownContent.
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
        source_text = file_bytes.decode("utf-8", errors="replace")
        markdown = await _normalise_to_markdown(
            session,
            cv_version,
            source_text,
            system_prompt=TEXT_REDACTION_SYSTEM_PROMPT,
            llm_provider=llm_provider,
            analysis_id=analysis_id,
        )
    elif cv_version.fileType == Cvfiletype.PDF:
        markdown = await _convert_pdf(
            session,
            cv_version,
            file_bytes,
            llm_provider=llm_provider,
            analysis_id=analysis_id,
        )
    elif cv_version.fileType == Cvfiletype.DOCX:
        markdown = await _convert_docx(
            session,
            cv_version,
            file_bytes,
            llm_provider=llm_provider,
            analysis_id=analysis_id,
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
    cv_version.styleProfile, cv_version.styleStatus = _derive_style_profile(
        cv_version, file_bytes, markdown, llm_provider=llm_provider
    )
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

    return await _normalise_to_markdown(
        session,
        cv_version,
        text,
        system_prompt=NORMALISATION_SYSTEM_PROMPT,
        llm_provider=llm_provider,
        analysis_id=analysis_id,
    )


async def _convert_docx(
    session: AsyncSession,
    cv_version: CVVersion,
    file_bytes: bytes,
    *,
    llm_provider: LLMProvider | None,
    analysis_id: str | None,
) -> str:
    """DOCX branch: `mammoth` docx -> semantic HTML, then the same LLM
    normalisation pass as the PDF branch. Returns the Markdown rendition, or
    raises CVConversionError (via _mark_failed) after recording the failure."""
    html = _extract_docx_html(file_bytes)
    return await _normalise_to_markdown(
        session,
        cv_version,
        html,
        system_prompt=NORMALISATION_SYSTEM_PROMPT,
        llm_provider=llm_provider,
        analysis_id=analysis_id,
    )


async def _fail_on_identity_leaks(
    session: AsyncSession,
    cv_version: CVVersion,
    markdown: str,
    *,
    analysis_id: str | None,
) -> None:
    """Redaction's deterministic safety net (docs/adr/0022): fails Conversion
    if the LLM left an email, a phone number, or the CVVersion owner's own
    account name/email in `markdown`. The error names only the categories, never
    the matched text, so `conversionError` cannot re-leak it."""
    owner = await session.get(User, cv_version.userId)
    leaks = find_identity_leaks(
        markdown,
        user_name=owner.name if owner else None,
        user_email=owner.email if owner else None,
    )
    if leaks:
        await _mark_failed(
            session,
            cv_version,
            "CV Conversion failed Redaction: identity data still present in the "
            f"Markdown rendition ({', '.join(leaks)}) "
            f"(cv_version_id={cv_version.id})",
            analysis_id,
        )


async def _normalise_to_markdown(
    session: AsyncSession,
    cv_version: CVVersion,
    source_text: str,
    *,
    system_prompt: str,
    llm_provider: LLMProvider | None,
    analysis_id: str | None,
) -> str:
    """Shared by every format's single Redaction-carrying LLM pass: truncate
    `source_text` (mechanically-extracted PDF/DOCX text, or an MD/TXT upload's
    own text) to MAX_TEXT_CHARS and run one LLM pass under `system_prompt`,
    retrying up to MAX_ATTEMPTS on an empty/erroring response. Both prompts carry
    the Redaction instructions (issues #166/#167), so the returned Markdown is
    then run through the deterministic safety net: any leftover identity data,
    like an exhausted retry budget, fails Conversion via _mark_failed with no
    unredacted fallback and no retry. Returns the stripped Markdown, or raises
    CVConversionError."""
    prompt = source_text[:MAX_TEXT_CHARS]
    provider = llm_provider or get_llm_provider()

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(
                system=system_prompt,
                prompt=prompt,
                max_tokens=NORMALISATION_MAX_TOKENS,
            )
        except Exception as exc:  # noqa: BLE001 — any provider error is a retryable attempt
            last_error = exc
            continue
        if raw and raw.strip():
            markdown = raw.strip()
            await _fail_on_identity_leaks(
                session, cv_version, markdown, analysis_id=analysis_id
            )
            return markdown
        last_error = ValueError("empty LLM response")

    await _mark_failed(
        session,
        cv_version,
        f"CV Conversion failed for {cv_version.id} after {MAX_ATTEMPTS} "
        f"normalisation attempts: {last_error}",
        analysis_id,
    )


def handle_cv_conversion(event: dict, context=None) -> None:
    """SQS event-source-mapping Lambda entrypoint for the manual "Convert to
    Markdown" trigger (issue #19). `event["Records"]` is a batch of
    `cv-conversion` messages, each with a JSON body `{"cvVersionId": "..."}`
    (per services/api's POST /v1/cv-versions/{id}/convert). Runs the same
    `convert_cv` the AnalysisWorkflow's EnsureCVConverted step uses, so the two
    paths cannot drift. A Conversion failure is already persisted as
    `conversionStatus = FAILED` on the row by `convert_cv`, so it is swallowed
    here rather than left to redeliver as a poison message; the next record is
    still processed.
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    body = json.loads(record["body"])
                    try:
                        await convert_cv(session, body["cvVersionId"])
                    except CVConversionError:
                        logger.exception(
                            "cv_conversion_failed for cv_version_id=%s",
                            body.get("cvVersionId"),
                        )
        finally:
            await engine.dispose()

    asyncio.run(_run())
