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
    User,
)
from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger
from sqlalchemy.ext.asyncio import AsyncSession

from .cover_letter_writer_agent import CoverLetterWriterError, run_cover_letter_writer
from .cv_tailoring_agent import CvTailoringError, run_cv_tailoring
from .llm_provider import LLMProvider
from .llm_provider_resolver import LLMProviderResolutionError, resolve_llm_provider
from .s3_client import S3_BUCKET, generated_document_key, make_s3_client

logger = get_logger(__name__)


class GenerationPipelineError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _offer_language(job_offer: JobOffer, *, fallback: str | None) -> str | None:
    """The offer's language when its structured data carries one, else
    `fallback`. Detection here is a plain dict lookup, not language
    identification from free text — a deeper implementation is deferred,
    same boundary as the pre-rank's lexical-only similarity in slice 3 (#55).
    Neither `JobOffer.structuredData` nor `User`/`CVVersion` carry a language
    anywhere today, so this always falls through to `fallback`
    (`locale_fallback`, `None` by default) — `run_cover_letter_writer`/
    `run_cv_tailoring` treat `None` as "match the CV/offer's own language"
    rather than forcing one. This used to default to `"en"`, which broke
    non-English candidates: instructing the writer to answer in English
    against an all-French CV/offer made the local dev model (qwen3.5)
    degenerate into dumping the raw CV instead of writing prose."""
    data = job_offer.structuredData or {}
    return data.get("language") or fallback


def _contact_lines(user: User | None) -> list[str]:
    """The account's `User.name`/`User.email` as Markdown lines (docs/adr/
    0022). The base CVVersion's rendition is redacted, so neither writer
    agent ever sees — let alone reproduces — the candidate's contact
    details; they come from the User row, outside the LLM call, so they are
    never fabricated. A null name or email is left out rather than rendered
    as a blank line.
    """
    lines = []
    if user is not None and user.name:
        lines.append(f"**{user.name}**")
    if user is not None and user.email:
        lines.append(user.email)
    return lines


def _with_contact_block(markdown: str, user: User | None) -> str:
    """Appends the contact lines to the end of a generated document's
    Markdown, as a closing signature — used for COVER_LETTER. With neither
    name nor email, `markdown` is returned unchanged.
    """
    lines = _contact_lines(user)
    if not lines:
        return markdown
    return f"{markdown.rstrip()}\n\n" + "\n".join(lines)


def _with_contact_header(markdown: str, user: User | None) -> str:
    """Inserts the contact lines right after the document's opening
    heading — used for TAILORED_CV, where contact info reads as a header,
    not a cover letter's closing signature. Inserted after the heading's
    `<!-- SectionType: X -->` comment too, when CvTailoringAgent wrote one
    (docs/adr #97), since `document_render._classify_lines` only attaches
    that comment to a heading when it is the line immediately below it — an
    intervening contact block would silently break that association. Falls
    back to inserting at the very top if the Markdown doesn't open with a
    heading. With neither name nor email, `markdown` is returned unchanged.
    """
    lines = _contact_lines(user)
    if not lines:
        return markdown

    raw_lines = markdown.splitlines()
    if not raw_lines or not raw_lines[0].startswith("#"):
        return "\n".join(lines) + "\n\n" + markdown

    insert_at = 1
    if insert_at < len(raw_lines):
        next_line = raw_lines[insert_at].strip()
        if next_line.startswith("<!--") and next_line.endswith("-->"):
            insert_at += 1

    before = "\n".join(raw_lines[:insert_at])
    after = "\n".join(raw_lines[insert_at:]).lstrip("\n")
    return f"{before}\n\n" + "\n".join(lines) + f"\n\n{after}"


async def run_generation_pipeline(
    session: AsyncSession,
    generated_document_id: str,
    *,
    llm_provider: LLMProvider | None = None,
    s3_client=None,
    locale_fallback: str | None = None,
) -> GeneratedDocument:
    """Runs one GeneratedDocument end to end in-process: loads its Analysis,
    JobOffer, and base CVVersion, runs the matching generation agent
    (CoverLetterWriterAgent for COVER_LETTER, CVTailoringAgent for
    TAILORED_CV), and writes the resulting Markdown to Postgres (canonical)
    and S3 (mirror), transitioning status PENDING -> GENERATING -> READY. The
    CVVersion owner's `User.name`/`User.email` are added to the agent's
    output first (docs/adr/0022), since the redacted base CV no longer
    carries them — appended as a closing signature for COVER_LETTER, or
    inserted right after the opening heading for TAILORED_CV.

    On any failure the row is left in a terminal FAILED status with a
    non-empty errorMessage and no partial markdownContent. Raises
    GenerationPipelineError.
    """
    document = await session.get(GeneratedDocument, generated_document_id)
    if document is None:
        raise GenerationPipelineError(
            f"GeneratedDocument {generated_document_id} not found"
        )

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
        message = (
            f"GeneratedDocument {generated_document_id} is missing a prerequisite row"
        )
        document.status = Generateddocumentstatus.FAILED
        document.errorMessage = message
        document.updatedAt = _now()
        await session.commit()
        raise GenerationPipelineError(message)

    result = analysis.resultJSON or {}
    matched_skills = result.get("matched_skills", [])
    missing_skills = result.get("missing_skills", [])
    language = _offer_language(job_offer, fallback=locale_fallback)

    try:
        provider = llm_provider or await resolve_llm_provider(session)
    except LLMProviderResolutionError as exc:
        message = str(exc)
        document.status = Generateddocumentstatus.FAILED
        document.errorMessage = message
        document.updatedAt = _now()
        await session.commit()
        raise GenerationPipelineError(message) from exc

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

    user = await session.get(User, cv_version.userId)
    if document.type == Generateddocumenttype.COVER_LETTER:
        markdown = _with_contact_block(markdown, user)
    else:
        markdown = _with_contact_header(markdown, user)

    s3 = s3_client or make_s3_client()
    key = generated_document_key(
        analysis.userId, document.analysisId, document.type.value
    )
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
