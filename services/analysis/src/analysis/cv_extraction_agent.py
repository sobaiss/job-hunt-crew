"""CVExtractionAgent (PRD Section 8.2, M2-T5).

Structures a CVVersion's uploaded file (PDF or DOCX, stored by M1-T3's
presigned-upload flow at CVVersion.fileKey) into CVVersion.structuredData.
Built on top of the LLM provider abstraction (analysis.llm_provider) rather
than importing an LLM SDK directly, mirroring job_offer_extraction_agent's
design (M2-T4).
"""

import io
import json
from datetime import UTC, datetime

from docx import Document
from py_db.models import CVVersion, Cvfiletype, Cvparsestatus
from pydantic import BaseModel, ValidationError
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import AsyncSession

from .llm_provider import LLMProvider, get_llm_provider
from .s3_client import S3_BUCKET, make_s3_client

MAX_ATTEMPTS = 3
MAX_TEXT_CHARS = 20000

SYSTEM_PROMPT = (
    "You extract structured data from the plain text of a candidate's CV/resume. "
    "Respond with ONLY a single JSON object, no markdown fences, no commentary, "
    "matching this shape: "
    '{"skills": [string], '
    '"experience": [{"title": string, "company": string, "startDate": string|null, '
    '"endDate": string|null, "description": string|null}], '
    '"education": [{"institution": string, "degree": string|null, "field": string|null, '
    '"startDate": string|null, "endDate": string|null}]}.'
)


class CVExperienceEntry(BaseModel):
    title: str
    company: str
    startDate: str | None = None
    endDate: str | None = None
    description: str | None = None


class CVEducationEntry(BaseModel):
    institution: str
    degree: str | None = None
    field: str | None = None
    startDate: str | None = None
    endDate: str | None = None


class CVStructuredData(BaseModel):
    skills: list[str]
    experience: list[CVExperienceEntry]
    education: list[CVEducationEntry]


class CVExtractionError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _extract_text(file_bytes: bytes, file_type: Cvfiletype) -> str:
    if file_type == Cvfiletype.PDF:
        reader = PdfReader(io.BytesIO(file_bytes))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if file_type == Cvfiletype.DOCX:
        document = Document(io.BytesIO(file_bytes))
        return "\n".join(paragraph.text for paragraph in document.paragraphs)
    raise CVExtractionError(f"Unsupported CV file type: {file_type}")


def _parse_llm_output(raw: str) -> CVStructuredData:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json") :]
    data = json.loads(text)
    return CVStructuredData.model_validate(data)


async def extract_cv(
    session: AsyncSession,
    cv_version_id: str,
    *,
    llm_provider: LLMProvider | None = None,
) -> CVVersion:
    """Structures CVVersion.fileKey's file (PDF or DOCX) into
    CVVersion.structuredData via the configured LLM provider, transitioning
    parseStatus PENDING -> PARSING -> PARSED. On repeated malformed/failed
    LLM output (up to MAX_ATTEMPTS), transitions to FAILED instead (mirrors
    JobOfferExtractionAgent's bounded-retry design, M2-T4).
    """
    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None:
        raise CVExtractionError(f"CVVersion {cv_version_id} not found")

    cv_version.parseStatus = Cvparsestatus.PARSING
    cv_version.updatedAt = _now()
    await session.commit()

    s3 = make_s3_client()
    obj = s3.get_object(Bucket=S3_BUCKET, Key=cv_version.fileKey)
    file_bytes = obj["Body"].read()
    text = _extract_text(file_bytes, cv_version.fileType)[:MAX_TEXT_CHARS]

    provider = llm_provider or get_llm_provider()

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(system=SYSTEM_PROMPT, prompt=text)
            structured = _parse_llm_output(raw)
        except (json.JSONDecodeError, ValidationError, TypeError) as exc:
            last_error = exc
            continue

        cv_version.structuredData = structured.model_dump()
        cv_version.structuredDataVer = (cv_version.structuredDataVer or 0) + 1
        cv_version.parseStatus = Cvparsestatus.PARSED
        cv_version.updatedAt = _now()
        await session.commit()
        return cv_version

    cv_version.parseStatus = Cvparsestatus.FAILED
    cv_version.updatedAt = _now()
    await session.commit()
    raise CVExtractionError(
        f"CV extraction failed for {cv_version_id} after {MAX_ATTEMPTS} attempts: {last_error}"
    )
