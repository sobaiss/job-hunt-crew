"""JobOfferExtractionAgent (PRD Section 8.3 step 5 / Section 10 step 5, M2-T4).

Structures a scraped JobOffer's raw HTML (stored by ingestion's scrape step,
M2-T2) into JobOffer.structuredData. Built on top of the LLM provider
abstraction (analysis.llm_provider) rather than importing an LLM SDK
directly, per that module's design intent.
"""

import json
import re
from datetime import UTC, datetime

from bs4 import BeautifulSoup
from py_db.models import JobOffer, Jobofferextractionstatus
from py_db.pipeline_events import record_pipeline_event
from py_db.structured_logging import get_logger, log_stage_event
from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from .json_ld import (
    find_job_posting,
    job_posting_fields,
    structured_data_from_job_posting,
)
from .llm_json import parse_llm_json
from .llm_provider import LLMProvider, retry_temperature
from .llm_provider_resolver import LLMProviderResolutionError, resolve_llm_provider
from .s3_client import S3_BUCKET, make_s3_client

logger = get_logger(__name__)

STAGE = "extract"

MAX_ATTEMPTS = 3
MAX_CONTENT_CHARS = 20000

# Markup that never carries job content but dominates a real page's byte count.
_NON_CONTENT_TAGS = ("script", "style", "noscript", "svg", "template", "iframe")

# High-signal metadata that lives in attributes, which plain text extraction
# would drop: `<time datetime>` is often the only machine-readable posting date
# on a page with no JSON-LD.
_META_PROPERTIES = ("og:title", "og:description", "og:site_name")
_MAX_TIME_ELEMENTS = 3

SYSTEM_PROMPT = (
    "You extract structured data from a job posting. The input is the visible "
    "text of the posting's page, preceded by a few page-metadata lines. "
    "Respond with ONLY a single JSON object, no markdown fences, no commentary, "
    "matching this shape: "
    '{"title": string|null, "company": string|null, "location": string|null, '
    '"postedAt": string|null, "description": string, "requirements": [string], '
    '"salary": string|null, "contractType": string|null, "remotePolicy": string|null, '
    '"seniority": string|null}. "postedAt" must be an ISO 8601 date if known, else null.'
)


class JobOfferStructuredData(BaseModel):
    description: str
    requirements: list[str]
    salary: str | None = None
    contractType: str | None = None
    remotePolicy: str | None = None
    seniority: str | None = None


class JobOfferLLMExtraction(JobOfferStructuredData):
    title: str | None = None
    company: str | None = None
    location: str | None = None
    postedAt: str | None = None


class ExtractionError(Exception):
    pass


_RESPONSE_SCHEMA = JobOfferLLMExtraction.model_json_schema()


def _page_metadata_lines(soup: BeautifulSoup) -> list[str]:
    """A handful of high-signal facts that live in attributes rather than in
    visible text, so extracting text alone wouldn't carry them."""
    lines: list[str] = []
    if soup.title and soup.title.get_text(strip=True):
        lines.append(f"page-title: {soup.title.get_text(strip=True)}")
    for prop in _META_PROPERTIES:
        tag = soup.find("meta", property=prop) or soup.find(
            "meta", attrs={"name": prop}
        )
        content = (tag.get("content") or "").strip() if tag else ""
        if content:
            lines.append(f"{prop}: {content}")
    for time_tag in soup.find_all("time", datetime=True)[:_MAX_TIME_ELEMENTS]:
        label = time_tag.get_text(" ", strip=True)
        lines.append(f"time: {time_tag['datetime']}{f' ({label})' if label else ''}")
    return lines


def build_llm_input(raw_html: str) -> str:
    """The page's job content, as the LLM tier should see it.

    This used to be `raw_html` with `<script>`/`<style>` removed, truncated to
    the first 20k characters. On a real job page that window is almost entirely
    `<head>` metadata, cookie-consent markup and hidden accessibility strings:
    measured across the 28 LinkedIn pages in the local database, 26 had their
    `<h1>` *beyond* the cutoff, so the model was asked to name a job whose
    title, company, location and description it had never been shown. Every
    extraction failure in that set was on a page with no JSON-LD to fall back
    on; not one page that had JSON-LD failed. docs/adr/0010 flagged exactly
    this cutoff when it moved the deterministic tier to search the untruncated
    HTML, but the LLM fallback kept eating the same useless prefix.

    So: take the content region (`<main>`, else `<body>`) as visible text,
    prefixed by the few attribute-borne facts text extraction would lose. On
    the same 28 pages this yields 11k-19k characters carrying the whole job
    block, and 26 of them fit under the cap with no truncation at all. The
    region still opens with some site navigation on sites whose `<main>`
    wraps it (or that have no `<main>` at all) — that's accepted: the point
    is that the job is now *present* and untruncated, not that it comes first.
    """
    soup = BeautifulSoup(raw_html, "html.parser")
    metadata = _page_metadata_lines(soup)
    for tag in soup(list(_NON_CONTENT_TAGS)):
        tag.decompose()

    # `<main>` is the content region on every site seeded so far; `<body>` is
    # the honest fallback, and `soup` itself covers a fragment with neither.
    region = soup.find("main") or soup.body or soup
    text = region.get_text("\n", strip=True)
    # Collapse the runs of blank lines that per-element extraction leaves
    # behind — they cost tokens and carry nothing.
    text = re.sub(r"\n{3,}", "\n\n", text)

    return "\n".join([*metadata, "", text]).strip()[:MAX_CONTENT_CHARS]


def _parse_posted_at(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _parse_llm_output(raw: str) -> JobOfferLLMExtraction:
    data = parse_llm_json(raw)
    return JobOfferLLMExtraction.model_validate(data)


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
    raw_html = obj["Body"].read().decode("utf-8")

    job_posting = find_job_posting(raw_html)
    if job_posting is not None:
        fields = job_posting_fields(job_posting)
        if fields["title"]:
            job_offer.title = fields["title"]
            job_offer.company = fields["company"]
            job_offer.location = fields["location"]
            job_offer.postedAt = fields["postedAt"]

            structured_data = structured_data_from_job_posting(job_posting)
            if structured_data is not None:
                job_offer.structuredData = JobOfferStructuredData(
                    **structured_data
                ).model_dump()
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
            # JSON-LD resolved title/company/location/postedAt but didn't carry
            # a usable description, so structuredData is still unset -- fall
            # through to the LLM tier below, which fills it in and, per the
            # merge logic there, keeps these already-resolved fields as-is.

    llm_input = build_llm_input(raw_html)

    async def _fail(message: str) -> None:
        job_offer.extractionStatus = Jobofferextractionstatus.FAILED
        job_offer.errorMessage = message
        job_offer.updatedAt = _now()
        await session.commit()
        log_stage_event(
            logger,
            stage=STAGE,
            status="FAILED",
            job_offer_id=job_offer_id,
            analysis_id=analysis_id,
            ingestion_job_id=ingestion_job_id,
            message=message,
        )
        await record_pipeline_event(
            session,
            stage=STAGE,
            status="FAILED",
            message=f"job_offer_id={job_offer_id}: {message}",
            analysis_id=analysis_id,
            ingestion_job_id=ingestion_job_id,
        )

    try:
        provider = llm_provider or await resolve_llm_provider(session)
    except LLMProviderResolutionError as exc:
        await _fail(str(exc))
        raise ExtractionError(str(exc)) from exc

    last_error: Exception | str | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(
                system=SYSTEM_PROMPT,
                prompt=llm_input,
                response_schema=_RESPONSE_SCHEMA,
                temperature=retry_temperature(attempt),
            )
            structured = _parse_llm_output(raw)
        except (json.JSONDecodeError, ValidationError, TypeError) as exc:
            last_error = exc
            continue

        title = job_offer.title or structured.title
        if not title:
            last_error = "LLM output did not resolve a title"
            continue

        job_offer.title = title
        job_offer.company = job_offer.company or structured.company
        job_offer.location = job_offer.location or structured.location
        job_offer.postedAt = job_offer.postedAt or _parse_posted_at(structured.postedAt)
        job_offer.structuredData = JobOfferStructuredData(
            **structured.model_dump(
                exclude={"title", "company", "location", "postedAt"}
            )
        ).model_dump()
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

    message = f"Extraction failed after {MAX_ATTEMPTS} attempts: {last_error}"
    await _fail(message)
    raise ExtractionError(message)
