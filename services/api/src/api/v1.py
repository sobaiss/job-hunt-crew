import json
import math
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvconversionstatus,
    Cvfiletype,
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    SiteConfig,
)
from py_db.quota import analyses_requested_today, daily_analysis_cap
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .db import get_session
from .s3_client import S3_BUCKET, cv_file_key, make_s3_client
from .sqs_client import (
    ANALYSIS_INTAKE_QUEUE_URL,
    CV_CONVERSION_QUEUE_URL,
    INGESTION_INTAKE_QUEUE_URL,
    SCOUT_INTAKE_QUEUE_URL,
    make_sqs_client,
)

router = APIRouter(prefix="/v1")


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


async def require_user_id(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> str:
    """Per PRD Section 7/14: services/api trusts the caller's userId header
    (paired with the shared INTERNAL_API_SECRET) rather than independently
    verifying a signed session — apps/web's BFF proxy is the only caller."""
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    return x_user_id


class SiteConfigResponse(BaseModel):
    id: str
    siteKey: str
    displayName: str
    baseUrl: str
    searchUrlTemplate: str | None
    filterParamMapping: dict[str, Any] | None
    listItemSelector: str | None
    offerLinkSelector: str | None
    offerTitleSelector: str | None
    integrationType: str
    apiBaseUrl: str | None
    requiresJsRendering: bool
    antiBotRiskLevel: str
    enabled: bool
    notes: str | None
    createdAt: datetime
    updatedAt: datetime


class SiteConfigListResponse(BaseModel):
    siteConfigs: list[SiteConfigResponse]


@router.get("/site-configs", response_model=SiteConfigListResponse)
async def list_site_configs(
    session: AsyncSession = Depends(get_session),
) -> SiteConfigListResponse:
    """Mirrors apps/web/app/api/site-configs/route.ts's shape (M7-T7): enabled
    SiteConfig rows, ordered by displayName, returned under a `siteConfigs`
    key so M7-T8's proxy can pass this payload straight through unchanged."""
    rows = (
        await session.scalars(
            select(SiteConfig).where(SiteConfig.enabled.is_(True)).order_by(SiteConfig.displayName)
        )
    ).all()
    return SiteConfigListResponse(
        siteConfigs=[
            SiteConfigResponse(
                id=row.id,
                siteKey=row.siteKey.value,
                displayName=row.displayName,
                baseUrl=row.baseUrl,
                searchUrlTemplate=row.searchUrlTemplate,
                filterParamMapping=row.filterParamMapping,
                listItemSelector=row.listItemSelector,
                offerLinkSelector=row.offerLinkSelector,
                offerTitleSelector=row.offerTitleSelector,
                integrationType=row.integrationType.value,
                apiBaseUrl=row.apiBaseUrl,
                requiresJsRendering=row.requiresJsRendering,
                antiBotRiskLevel=row.antiBotRiskLevel.value,
                enabled=row.enabled,
                notes=row.notes,
                createdAt=row.createdAt,
                updatedAt=row.updatedAt,
            )
            for row in rows
        ]
    )


# --- CV versions (M7-T9) ---
# Ports apps/web/app/api/cv-versions/{route.ts,[id]/route.ts}'s validation and
# single-isDefault transaction verbatim; the presigned-upload flow (browser
# PUTs bytes directly to S3) is unchanged (PRD Section 9.2).

CONTENT_TYPE_TO_FILE_TYPE: dict[str, Cvfiletype] = {
    "application/pdf": Cvfiletype.PDF,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Cvfiletype.DOCX,
    "text/markdown": Cvfiletype.MD,
    "text/plain": Cvfiletype.TXT,
}


def _resolve_cv_file_type(content_type: str, file_name: str) -> Cvfiletype | None:
    """Maps an upload's content type to the stored CVFileType. Browsers often
    send a generic `text/plain` for a `.md` file, so when the content type is
    `text/plain` the filename extension breaks the tie (`.md` -> MD, else TXT).
    MD and TXT are handled identically downstream (issue #16).
    """
    file_type = CONTENT_TYPE_TO_FILE_TYPE.get(content_type)
    if file_type is Cvfiletype.TXT and file_name.lower().endswith(".md"):
        return Cvfiletype.MD
    return file_type

UPLOAD_URL_EXPIRY_SECONDS = 300
# PRD Section 13 default: CV max size 10MB.
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024


class CVVersionResponse(BaseModel):
    id: str
    userId: str
    label: str
    fileKey: str
    fileName: str
    fileType: str
    fileSizeBytes: int
    isDefault: bool
    conversionStatus: str
    conversionError: str | None
    createdAt: datetime
    updatedAt: datetime


class CVVersionListResponse(BaseModel):
    cvVersions: list[CVVersionResponse]


def _cv_version_response(row: CVVersion) -> CVVersionResponse:
    return CVVersionResponse(
        id=row.id,
        userId=row.userId,
        label=row.label,
        fileKey=row.fileKey,
        fileName=row.fileName,
        fileType=row.fileType.value,
        fileSizeBytes=row.fileSizeBytes,
        isDefault=row.isDefault,
        conversionStatus=row.conversionStatus.value,
        conversionError=row.conversionError,
        createdAt=row.createdAt,
        updatedAt=row.updatedAt,
    )


@router.get("/cv-versions", response_model=CVVersionListResponse)
async def list_cv_versions(
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> CVVersionListResponse:
    rows = (
        await session.scalars(
            select(CVVersion).where(CVVersion.userId == user_id).order_by(CVVersion.createdAt.desc())
        )
    ).all()
    return CVVersionListResponse(cvVersions=[_cv_version_response(row) for row in rows])


class CreateCVVersionRequest(BaseModel):
    label: Any = None
    fileName: Any = None
    contentType: Any = None
    fileSizeBytes: Any = None


class CreateCVVersionResponse(BaseModel):
    cvVersionId: str
    fileKey: str
    uploadUrl: str


@router.post("/cv-versions", response_model=CreateCVVersionResponse, status_code=201)
async def create_cv_version(
    req: CreateCVVersionRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> CreateCVVersionResponse:
    label = req.label.strip() if isinstance(req.label, str) else ""
    file_name = req.fileName.strip() if isinstance(req.fileName, str) else ""
    content_type = req.contentType if isinstance(req.contentType, str) else ""
    file_size_bytes = req.fileSizeBytes

    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    if not file_name:
        raise HTTPException(status_code=400, detail="fileName is required")
    if (
        not isinstance(file_size_bytes, int | float)
        or isinstance(file_size_bytes, bool)
        or not math.isfinite(file_size_bytes)
        or file_size_bytes <= 0
    ):
        raise HTTPException(status_code=400, detail="fileSizeBytes must be a positive number")

    file_type = _resolve_cv_file_type(content_type, file_name)
    if file_type is None:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type; only PDF, DOCX, Markdown, and plain text are supported",
        )
    if file_size_bytes > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large; max size is {MAX_FILE_SIZE_BYTES // (1024 * 1024)}MB",
        )

    cv_version_id = str(uuid.uuid4())
    file_key = cv_file_key(user_id, cv_version_id, file_name)

    cv_version = CVVersion(
        id=cv_version_id,
        userId=user_id,
        label=label,
        fileKey=file_key,
        fileName=file_name,
        fileType=file_type,
        fileSizeBytes=int(file_size_bytes),
        updatedAt=_now(),
    )
    session.add(cv_version)
    await session.commit()

    s3 = make_s3_client()
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": S3_BUCKET, "Key": file_key, "ContentType": content_type},
        ExpiresIn=UPLOAD_URL_EXPIRY_SECONDS,
    )

    return CreateCVVersionResponse(cvVersionId=cv_version.id, fileKey=file_key, uploadUrl=upload_url)


class UpdateCVVersionRequest(BaseModel):
    label: Any = None
    isDefault: Any = None


class UpdateCVVersionResponse(BaseModel):
    cvVersion: CVVersionResponse


@router.patch("/cv-versions/{cv_version_id}", response_model=UpdateCVVersionResponse)
async def update_cv_version(
    cv_version_id: str,
    req: UpdateCVVersionRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> UpdateCVVersionResponse:
    existing = await session.get(CVVersion, cv_version_id)
    if existing is None or existing.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    label_provided = isinstance(req.label, str)
    label = req.label.strip() if label_provided else None
    is_default_provided = isinstance(req.isDefault, bool)
    is_default = req.isDefault if is_default_provided else None

    if not label_provided and not is_default_provided:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if label_provided and not label:
        raise HTTPException(status_code=400, detail="label must not be empty")

    if is_default_provided and is_default:
        await session.execute(
            update(CVVersion)
            .where(
                CVVersion.userId == user_id,
                CVVersion.isDefault.is_(True),
                CVVersion.id != cv_version_id,
            )
            .values(isDefault=False, updatedAt=_now())
        )

    if label_provided:
        existing.label = label
    if is_default_provided:
        existing.isDefault = is_default
    existing.updatedAt = _now()

    await session.commit()
    await session.refresh(existing)

    return UpdateCVVersionResponse(cvVersion=_cv_version_response(existing))


@router.delete("/cv-versions/{cv_version_id}", status_code=204)
async def delete_cv_version(
    cv_version_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete a CV version the caller owns. Rejected with a 409 naming the
    referencing Scouts while any Scout still uses it as its base CV — the
    `Scout.cvVersionId` FK is `onDelete: Restrict` (issue #53). User-scoped:
    another user's CV is a 404, not a 403.
    """
    existing = await session.get(CVVersion, cv_version_id)
    if existing is None or existing.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    referencing = (
        await session.scalars(
            select(Scout).where(Scout.cvVersionId == cv_version_id).order_by(Scout.createdAt)
        )
    ).all()
    if referencing:
        labels = ", ".join(f'"{scout.label}"' for scout in referencing)
        raise HTTPException(
            status_code=409,
            detail=f"This CV version is used by {len(referencing)} Scout(s): {labels}. "
            "Point those Scouts at another CV first.",
        )

    await session.delete(existing)
    await session.commit()


class CVVersionMarkdownResponse(BaseModel):
    markdownContent: str | None
    conversionStatus: str


@router.get(
    "/cv-versions/{cv_version_id}/markdown", response_model=CVVersionMarkdownResponse
)
async def get_cv_version_markdown(
    cv_version_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> CVVersionMarkdownResponse:
    """The Markdown rendition of a CV version, fetched on demand by the
    read-only preview panel (issue #20). User-scoped exactly like the PATCH:
    another user's CV is a 404, not a 403.
    """
    existing = await session.get(CVVersion, cv_version_id)
    if existing is None or existing.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    return CVVersionMarkdownResponse(
        markdownContent=existing.markdownContent,
        conversionStatus=existing.conversionStatus.value,
    )


class ConvertCVVersionResponse(BaseModel):
    conversionStatus: str


@router.post(
    "/cv-versions/{cv_version_id}/convert",
    response_model=ConvertCVVersionResponse,
    status_code=202,
)
async def convert_cv_version(
    cv_version_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> ConvertCVVersionResponse:
    """Manual "Convert to Markdown" / "Reconvert" trigger (issue #19).
    User-scoped exactly like the PATCH: another user's CV is a 404, not a 403.
    Returns 409 while a Conversion is already running for this CV; otherwise
    resets conversionStatus to PENDING, enqueues `{"cvVersionId": id}` on the
    `cv-conversion` queue (drained by services/analysis's handle_cv_conversion,
    which runs the same convert_cv the AnalysisWorkflow prerequisite uses), and
    returns 202 with the new status.
    """
    existing = await session.get(CVVersion, cv_version_id)
    if existing is None or existing.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    if existing.conversionStatus == Cvconversionstatus.CONVERTING:
        raise HTTPException(status_code=409, detail="A Conversion is already running for this CV")

    existing.conversionStatus = Cvconversionstatus.PENDING
    existing.conversionError = None
    existing.updatedAt = _now()
    await session.commit()

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=CV_CONVERSION_QUEUE_URL,
        MessageBody=json.dumps({"cvVersionId": cv_version_id}),
    )

    return ConvertCVVersionResponse(conversionStatus=existing.conversionStatus.value)


# --- Ingestion jobs (M7-T11, matching flow #27) ---
# Ports apps/web/app/api/ingestion-jobs/{route.ts,[id]/route.ts}'s mode/filter
# validation and INGESTION_MAX_OFFERS default (PRD Section 8.5, 11/13). Both
# SINGLE_URL and SITE_SEARCH now carry a caller-owned CONVERTED cvVersionId and,
# on success, enqueue `{"ingestionJobId": id}` on the ingestion-intake queue for
# the worker (#27) to run the pipeline and create the Analysis.

POSTED_WITHIN_VALUES = ("24h", "7d", "14d", "30d", "any")
REMOTE_VALUES = ("onsite", "hybrid", "remote")
INGESTION_MODES = ("SINGLE_URL", "SITE_SEARCH")

DEFAULT_MAX_OFFERS = 25


def _ingestion_max_offers() -> int:
    raw = os.environ.get("INGESTION_MAX_OFFERS")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_MAX_OFFERS


def _clamp_max_offers(value: Any) -> int:
    """SITE_SEARCH's maxOffers, taken from the request when a finite number is
    given and clamped to 1..INGESTION_MAX_OFFERS; defaults to the ceiling when
    absent or unparseable. SINGLE_URL always forces maxOffers = 1.
    """
    ceiling = _ingestion_max_offers()
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
    ):
        return ceiling
    return max(1, min(int(value), ceiling))


def _optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


class JobOfferResponse(BaseModel):
    id: str
    sourceUrl: str
    sourceSite: str
    title: str | None
    company: str | None
    location: str | None
    postedAt: datetime | None
    rawContentKey: str | None
    structuredData: dict[str, Any] | None
    extractionStatus: str
    errorMessage: str | None
    createdAt: datetime
    updatedAt: datetime


def _job_offer_response(row: JobOffer) -> JobOfferResponse:
    return JobOfferResponse(
        id=row.id,
        sourceUrl=row.sourceUrl,
        sourceSite=row.sourceSite.value,
        title=row.title,
        company=row.company,
        location=row.location,
        postedAt=row.postedAt,
        rawContentKey=row.rawContentKey,
        structuredData=row.structuredData,
        extractionStatus=row.extractionStatus.value,
        errorMessage=row.errorMessage,
        createdAt=row.createdAt,
        updatedAt=row.updatedAt,
    )


class IngestionJobResponse(BaseModel):
    id: str
    userId: str
    mode: str
    inputUrl: str | None
    siteConfigId: str | None
    cvVersionId: str | None
    filters: dict[str, Any] | None
    maxOffers: int
    status: str
    discoveredCount: int
    scrapedCount: int
    failedCount: int
    quotaSkippedCount: int
    errorMessage: str | None
    createdAt: datetime
    updatedAt: datetime


def _ingestion_job_response(row: IngestionJob) -> IngestionJobResponse:
    return IngestionJobResponse(
        id=row.id,
        userId=row.userId,
        mode=row.mode.value,
        inputUrl=row.inputUrl,
        siteConfigId=row.siteConfigId,
        cvVersionId=row.cvVersionId,
        filters=row.filters,
        maxOffers=row.maxOffers,
        status=row.status.value,
        discoveredCount=row.discoveredCount,
        scrapedCount=row.scrapedCount,
        failedCount=row.failedCount,
        quotaSkippedCount=row.quotaSkippedCount,
        errorMessage=row.errorMessage,
        createdAt=row.createdAt,
        updatedAt=row.updatedAt,
    )


class IngestionJobOfferResponse(BaseModel):
    id: str
    ingestionJobId: str
    jobOfferId: str
    createdAt: datetime
    jobOffer: JobOfferResponse


class IngestionJobDetailResponse(IngestionJobResponse):
    jobOffers: list[IngestionJobOfferResponse]


class GetIngestionJobResponse(BaseModel):
    ingestionJob: IngestionJobDetailResponse


def _ingestion_job_detail_response(row: IngestionJob) -> IngestionJobDetailResponse:
    return IngestionJobDetailResponse(
        **_ingestion_job_response(row).model_dump(),
        jobOffers=[
            IngestionJobOfferResponse(
                id=join.id,
                ingestionJobId=join.ingestionJobId,
                jobOfferId=join.jobOfferId,
                createdAt=join.createdAt,
                jobOffer=_job_offer_response(join.JobOffer_),
            )
            for join in row.IngestionJobOffer
        ],
    )


class CreateIngestionJobRequest(BaseModel):
    mode: Any = None
    inputUrl: Any = None
    siteConfigId: Any = None
    cvVersionId: Any = None
    filters: dict[str, Any] | None = None
    maxOffers: Any = None


class CreateIngestionJobResponse(BaseModel):
    ingestionJob: IngestionJobResponse


@router.post("/ingestion-jobs", response_model=CreateIngestionJobResponse, status_code=201)
async def create_ingestion_job(
    req: CreateIngestionJobRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> CreateIngestionJobResponse:
    if req.mode not in INGESTION_MODES:
        raise HTTPException(status_code=400, detail="mode must be SINGLE_URL or SITE_SEARCH")

    input_url: str | None = None
    site_config_id: str | None = None
    filters: dict[str, Any] | None = None
    max_offers = 1

    if req.mode == "SINGLE_URL":
        input_url = _optional_string(req.inputUrl)
        if not input_url:
            raise HTTPException(status_code=400, detail="inputUrl is required for SINGLE_URL")
    else:
        site_config_id = _optional_string(req.siteConfigId)
        if not site_config_id:
            raise HTTPException(status_code=400, detail="siteConfigId is required")

        site_config = await session.get(SiteConfig, site_config_id)
        if site_config is None or not site_config.enabled:
            raise HTTPException(status_code=400, detail="Unknown or disabled siteConfigId")

        filters_in = req.filters or {}

        posted_within = _optional_string(filters_in.get("postedWithin"))
        if posted_within is not None and posted_within not in POSTED_WITHIN_VALUES:
            raise HTTPException(
                status_code=400,
                detail=f"filters.postedWithin must be one of: {', '.join(POSTED_WITHIN_VALUES)}",
            )

        remote = _optional_string(filters_in.get("remote"))
        if remote is not None and remote not in REMOTE_VALUES:
            raise HTTPException(
                status_code=400,
                detail=f"filters.remote must be one of: {', '.join(REMOTE_VALUES)}",
            )

        filters = {
            "keywords": _optional_string(filters_in.get("keywords")),
            "location": _optional_string(filters_in.get("location")),
            "postedWithin": posted_within,
            "contractType": _optional_string(filters_in.get("contractType")),
            "remote": remote,
            "experienceLevel": _optional_string(filters_in.get("experienceLevel")),
        }
        max_offers = _clamp_max_offers(req.maxOffers)

    # cvVersionId is required for both modes: it must reference a CV the caller
    # owns whose Conversion has succeeded, since the worker matches against its
    # Markdown rendition (PRD Section 8.6; only CONVERTED CVs are selectable).
    cv_version_id = _optional_string(req.cvVersionId)
    if not cv_version_id:
        raise HTTPException(status_code=400, detail="cvVersionId is required")

    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None or cv_version.userId != user_id:
        raise HTTPException(status_code=400, detail="Unknown cvVersionId")
    if cv_version.conversionStatus != Cvconversionstatus.CONVERTED:
        raise HTTPException(status_code=400, detail="cvVersionId must reference a CONVERTED CV")

    ingestion_job = IngestionJob(
        id=str(uuid.uuid4()),
        userId=user_id,
        mode=Ingestionmode(req.mode),
        inputUrl=input_url,
        siteConfigId=site_config_id,
        cvVersionId=cv_version_id,
        filters=filters,
        maxOffers=max_offers,
        status=Ingestionjobstatus.PENDING,
        updatedAt=_now(),
    )
    session.add(ingestion_job)
    await session.commit()
    await session.refresh(ingestion_job)

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=INGESTION_INTAKE_QUEUE_URL,
        MessageBody=json.dumps({"ingestionJobId": ingestion_job.id}),
    )

    return CreateIngestionJobResponse(ingestionJob=_ingestion_job_response(ingestion_job))


@router.get("/ingestion-jobs/{ingestion_job_id}", response_model=GetIngestionJobResponse)
async def get_ingestion_job(
    ingestion_job_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetIngestionJobResponse:
    stmt = (
        select(IngestionJob)
        .options(selectinload(IngestionJob.IngestionJobOffer).selectinload(IngestionJobOffer.JobOffer_))
        .where(IngestionJob.id == ingestion_job_id)
    )
    ingestion_job = (await session.scalars(stmt)).first()
    if ingestion_job is None or ingestion_job.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    return GetIngestionJobResponse(ingestionJob=_ingestion_job_detail_response(ingestion_job))


# --- Job offers ---
# Backs the "Analyse one offer" known-offer shortcut (#29): the screen looks the
# pasted URL up before deciding whether to open an IngestionJob or create the
# Analysis directly.


class LookupJobOfferResponse(BaseModel):
    jobOffer: JobOfferResponse | None


@router.get("/job-offers", response_model=LookupJobOfferResponse)
async def lookup_job_offer(
    url: str | None = None,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> LookupJobOfferResponse:
    """Look up a globally-deduplicated JobOffer by its exact ``sourceUrl``. The
    "Analyse one offer" screen calls this on submit: when the pasted URL already
    resolves to a ``READY`` JobOffer it creates the Analysis straight away via
    ``POST /v1/analyses`` instead of opening an IngestionJob. ``url`` is matched
    verbatim against ``JobOffer.sourceUrl`` — the same key the SINGLE_URL
    pipeline get-or-creates against — and ``{"jobOffer": null}`` is returned
    when nothing matches (an unknown URL takes the ingestion path).
    """
    normalized = _optional_string(url)
    if not normalized:
        raise HTTPException(status_code=400, detail="url is required")

    row = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == normalized))
    return LookupJobOfferResponse(jobOffer=_job_offer_response(row) if row else None)


# --- Analyses (M7-T13) ---
# Ports apps/web/app/api/analyses/{route.ts,[id]/route.ts}'s daily-cap check
# and SQS enqueue verbatim (PRD Section 9.2, Section 10 steps 1-2, 11). The cap
# check itself lives in the shared `py_db.quota` helper (issue #33) so this
# route and the ingestion fan-out enforce one identical rule.


class AnalysisIngestionJobRef(BaseModel):
    """The slice of the parent IngestionJob the Dashboard needs to fold a
    SITE_SEARCH Analysis batch into one grouped row (issue #34): the `mode`
    (only `SITE_SEARCH` rows are grouped) and the `siteConfigId` (the row
    resolves its site displayName from this)."""

    mode: str
    siteConfigId: str | None


class AnalysisResponse(BaseModel):
    id: str
    userId: str
    jobOfferId: str
    cvVersionId: str
    ingestionJobId: str | None
    scoutId: str | None
    status: str
    s3ResultKey: str | None
    matchScore: int | None
    resultJSON: dict[str, Any] | None
    errorMessage: str | None
    stepFunctionExecutionArn: str | None
    requestedAt: datetime
    startedAt: datetime | None
    completedAt: datetime | None
    jobOffer: JobOfferResponse
    cvVersion: CVVersionResponse
    ingestionJob: AnalysisIngestionJobRef | None


def _analysis_response(row: Analysis) -> AnalysisResponse:
    ingestion_job = row.IngestionJob_
    return AnalysisResponse(
        id=row.id,
        userId=row.userId,
        jobOfferId=row.jobOfferId,
        cvVersionId=row.cvVersionId,
        ingestionJobId=row.ingestionJobId,
        scoutId=row.scoutId,
        status=row.status.value,
        s3ResultKey=row.s3ResultKey,
        matchScore=row.matchScore,
        resultJSON=row.resultJSON,
        errorMessage=row.errorMessage,
        stepFunctionExecutionArn=row.stepFunctionExecutionArn,
        requestedAt=row.requestedAt,
        startedAt=row.startedAt,
        completedAt=row.completedAt,
        jobOffer=_job_offer_response(row.JobOffer_),
        cvVersion=_cv_version_response(row.CVVersion_),
        ingestionJob=(
            AnalysisIngestionJobRef(
                mode=ingestion_job.mode.value,
                siteConfigId=ingestion_job.siteConfigId,
            )
            if ingestion_job is not None
            else None
        ),
    )


class AnalysisListResponse(BaseModel):
    analyses: list[AnalysisResponse]


@router.get("/analyses", response_model=AnalysisListResponse)
async def list_analyses(
    jobOfferId: str | None = None,
    ingestionJobId: str | None = None,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> AnalysisListResponse:
    stmt = (
        select(Analysis)
        .options(
            selectinload(Analysis.JobOffer_),
            selectinload(Analysis.CVVersion_),
            selectinload(Analysis.IngestionJob_),
        )
        .where(Analysis.userId == user_id)
        .order_by(Analysis.requestedAt.desc())
    )
    if jobOfferId:
        stmt = stmt.where(Analysis.jobOfferId == jobOfferId)
    if ingestionJobId:
        stmt = stmt.where(Analysis.ingestionJobId == ingestionJobId)
    rows = (await session.scalars(stmt)).all()
    return AnalysisListResponse(analyses=[_analysis_response(row) for row in rows])


class AnalysisQuota(BaseModel):
    cap: int
    used: int
    remaining: int


class AnalysisQuotaResponse(BaseModel):
    quota: AnalysisQuota


# Declared before `/analyses/{analysis_id}` so "quota" is matched here rather
# than captured as an analysis id.
@router.get("/analyses/quota", response_model=AnalysisQuotaResponse)
async def get_analyses_quota(
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> AnalysisQuotaResponse:
    """The caller's per-user daily analysis budget: `cap`
    (`DAILY_ANALYSIS_CAP`), how many `Analysis` rows they have `used` since
    00:00 UTC, and how many `remaining` (floored at 0). Backs the "Analyse
    several offers" pre-submit estimate — "up to N analyses will run — M left
    today" (issue #33). Same shared `py_db.quota` rule `POST /v1/analyses`
    enforces for its 429.
    """
    cap = daily_analysis_cap()
    used = await analyses_requested_today(session, user_id)
    return AnalysisQuotaResponse(
        quota=AnalysisQuota(cap=cap, used=used, remaining=max(cap - used, 0))
    )


class CreateAnalysisRequest(BaseModel):
    jobOfferId: Any = None
    cvVersionId: Any = None


class CreateAnalysisResponse(BaseModel):
    analysisId: str


@router.post("/analyses", response_model=CreateAnalysisResponse, status_code=202)
async def create_analysis(
    req: CreateAnalysisRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> CreateAnalysisResponse:
    job_offer_id = req.jobOfferId if isinstance(req.jobOfferId, str) else None
    cv_version_id = req.cvVersionId if isinstance(req.cvVersionId, str) else None
    if not job_offer_id or not cv_version_id:
        raise HTTPException(status_code=400, detail="jobOfferId and cvVersionId are required")

    # JobOffer is globally deduplicated (not user-owned, PRD Section 6), so
    # only existence is checked; CVVersion is user-scoped and must belong to
    # the caller.
    job_offer = await session.get(JobOffer, job_offer_id)
    if job_offer is None:
        raise HTTPException(status_code=400, detail="Unknown jobOfferId")

    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None or cv_version.userId != user_id:
        raise HTTPException(status_code=400, detail="Unknown cvVersionId")

    daily_cap = daily_analysis_cap()
    if await analyses_requested_today(session, user_id) >= daily_cap:
        raise HTTPException(
            status_code=429,
            detail=f"Daily analysis limit of {daily_cap} reached. Try again tomorrow.",
        )

    analysis = Analysis(
        id=str(uuid.uuid4()),
        userId=user_id,
        jobOfferId=job_offer_id,
        cvVersionId=cv_version_id,
        status=Analysisstatus.PENDING,
    )
    session.add(analysis)
    await session.commit()

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=ANALYSIS_INTAKE_QUEUE_URL,
        MessageBody=json.dumps({"analysisId": analysis.id}),
    )

    return CreateAnalysisResponse(analysisId=analysis.id)


class GetAnalysisResponse(BaseModel):
    analysis: AnalysisResponse


@router.get("/analyses/{analysis_id}", response_model=GetAnalysisResponse)
async def get_analysis(
    analysis_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetAnalysisResponse:
    stmt = (
        select(Analysis)
        .options(
            selectinload(Analysis.JobOffer_),
            selectinload(Analysis.CVVersion_),
            selectinload(Analysis.IngestionJob_),
        )
        .where(Analysis.id == analysis_id)
    )
    analysis = (await session.scalars(stmt)).first()
    if analysis is None or analysis.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    return GetAnalysisResponse(analysis=_analysis_response(analysis))


# --- Scouts (issue #53, Scout slice 1) ---
# CRUD for the saved, self-running search + match configs a Candidate manages
# from the "Agents" area. Scouts do not run yet — this slice is create / list /
# get / patch (relabel, reconfigure, pause / resume / archive) plus the
# MAX_SCOUTS_PER_USER guard. Every route is user-scoped: another user's Scout is
# a 404, never a 403 (same convention as cv-versions / analyses).

DEFAULT_MAX_SCOUTS_PER_USER = 5
VALID_SITE_KEYS = ("LINKEDIN", "INDEED", "FRANCE_TRAVAIL", "WTTJ", "GLASSDOOR")
SCOUT_STATUS_VALUES = ("ACTIVE", "PAUSED", "ARCHIVED")
DEFAULT_SCOUT_MATCH_THRESHOLD = 70


def _max_scouts_per_user() -> int:
    raw = os.environ.get("MAX_SCOUTS_PER_USER")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_MAX_SCOUTS_PER_USER


def _normalize_site_keys(value: Any) -> list[str]:
    if not isinstance(value, list) or not value:
        raise HTTPException(status_code=400, detail="targetSiteKeys must be a non-empty array")
    keys: list[str] = []
    for entry in value:
        if not isinstance(entry, str) or entry not in VALID_SITE_KEYS:
            raise HTTPException(
                status_code=400,
                detail=f"targetSiteKeys entries must be one of: {', '.join(VALID_SITE_KEYS)}",
            )
        if entry not in keys:
            keys.append(entry)
    return keys


def _normalize_scout_filters(value: Any) -> dict[str, Any]:
    filters_in = value if isinstance(value, dict) else {}

    posted_within = _optional_string(filters_in.get("postedWithin"))
    if posted_within is not None and posted_within not in POSTED_WITHIN_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"filters.postedWithin must be one of: {', '.join(POSTED_WITHIN_VALUES)}",
        )

    remote = _optional_string(filters_in.get("remote"))
    if remote is not None and remote not in REMOTE_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"filters.remote must be one of: {', '.join(REMOTE_VALUES)}",
        )

    return {
        "keywords": _optional_string(filters_in.get("keywords")),
        "location": _optional_string(filters_in.get("location")),
        "postedWithin": posted_within,
        "contractType": _optional_string(filters_in.get("contractType")),
        "remote": remote,
        "experienceLevel": _optional_string(filters_in.get("experienceLevel")),
    }


def _normalize_threshold(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
    ):
        raise HTTPException(
            status_code=400, detail="matchThreshold must be a number between 0 and 100"
        )
    parsed = int(value)
    if parsed < 0 or parsed > 100:
        raise HTTPException(status_code=400, detail="matchThreshold must be between 0 and 100")
    return parsed


async def _active_scout_count(session: AsyncSession, user_id: str, *, exclude_id: str | None = None) -> int:
    stmt = select(func.count()).select_from(Scout).where(
        Scout.userId == user_id, Scout.status == Scoutstatus.ACTIVE
    )
    if exclude_id is not None:
        stmt = stmt.where(Scout.id != exclude_id)
    return int((await session.scalar(stmt)) or 0)


async def _owned_cv_version(session: AsyncSession, cv_version_id: str, user_id: str) -> CVVersion:
    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None or cv_version.userId != user_id:
        raise HTTPException(status_code=400, detail="Unknown cvVersionId")
    return cv_version


class ScoutResponse(BaseModel):
    id: str
    userId: str
    label: str
    cvVersionId: str
    targetSiteKeys: list[str]
    filters: dict[str, Any]
    matchThreshold: int
    status: str
    lastRunAt: datetime | None
    createdAt: datetime
    updatedAt: datetime
    # Un-actioned relevant finds (completed Analyses with matchScore >=
    # matchThreshold) for this Scout — issue #56. There is no "actioned"
    # tracking yet (Application lands in slice 7 / #59), so every relevant
    # find currently counts; the field name is kept forward-looking so the
    # Dashboard block doesn't need a contract change once that lands.
    relevantFindsCount: int


def _scout_response(row: Scout, relevant_finds_count: int = 0) -> ScoutResponse:
    return ScoutResponse(
        id=row.id,
        userId=row.userId,
        label=row.label,
        cvVersionId=row.cvVersionId,
        targetSiteKeys=list(row.targetSiteKeys or []),
        filters=dict(row.filters or {}),
        matchThreshold=row.matchThreshold,
        status=row.status.value,
        lastRunAt=row.lastRunAt,
        createdAt=row.createdAt,
        updatedAt=row.updatedAt,
        relevantFindsCount=relevant_finds_count,
    )


async def _relevant_finds_count(session: AsyncSession, scout_id: str, threshold: int) -> int:
    stmt = select(func.count()).select_from(Analysis).where(
        Analysis.scoutId == scout_id,
        Analysis.status == Analysisstatus.COMPLETED,
        Analysis.matchScore >= threshold,
    )
    return int((await session.scalar(stmt)) or 0)


async def _relevant_finds_counts_by_scout(
    session: AsyncSession, user_id: str
) -> dict[str, int]:
    """One grouped query for the whole list, so `list_scouts` (which backs the
    Dashboard's cross-Scout "new matches" block, issue #56) avoids an N+1."""
    stmt = (
        select(Analysis.scoutId, func.count())
        .select_from(Analysis)
        .join(Scout, Scout.id == Analysis.scoutId)
        .where(
            Scout.userId == user_id,
            Analysis.status == Analysisstatus.COMPLETED,
            Analysis.matchScore >= Scout.matchThreshold,
        )
        .group_by(Analysis.scoutId)
    )
    rows = (await session.execute(stmt)).all()
    return {scout_id: count for scout_id, count in rows}


class ScoutListResponse(BaseModel):
    scouts: list[ScoutResponse]


class GetScoutResponse(BaseModel):
    scout: ScoutResponse


@router.get("/scouts", response_model=ScoutListResponse)
async def list_scouts(
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> ScoutListResponse:
    rows = (
        await session.scalars(
            select(Scout).where(Scout.userId == user_id).order_by(Scout.createdAt.desc())
        )
    ).all()
    counts = await _relevant_finds_counts_by_scout(session, user_id)
    return ScoutListResponse(
        scouts=[_scout_response(row, counts.get(row.id, 0)) for row in rows]
    )


class CreateScoutRequest(BaseModel):
    label: Any = None
    cvVersionId: Any = None
    targetSiteKeys: Any = None
    filters: Any = None
    matchThreshold: Any = None


@router.post("/scouts", response_model=GetScoutResponse, status_code=201)
async def create_scout(
    req: CreateScoutRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetScoutResponse:
    label = req.label.strip() if isinstance(req.label, str) else ""
    if not label:
        raise HTTPException(status_code=400, detail="label is required")

    cv_version_id = _optional_string(req.cvVersionId)
    if not cv_version_id:
        raise HTTPException(status_code=400, detail="cvVersionId is required")
    await _owned_cv_version(session, cv_version_id, user_id)

    target_site_keys = _normalize_site_keys(req.targetSiteKeys)
    filters = _normalize_scout_filters(req.filters)
    match_threshold = (
        DEFAULT_SCOUT_MATCH_THRESHOLD
        if req.matchThreshold is None
        else _normalize_threshold(req.matchThreshold)
    )

    cap = _max_scouts_per_user()
    if await _active_scout_count(session, user_id) >= cap:
        raise HTTPException(
            status_code=400,
            detail=(
                f"You can have at most {cap} active Scouts. "
                "Pause or archive one before creating another."
            ),
        )

    scout = Scout(
        id=str(uuid.uuid4()),
        userId=user_id,
        label=label,
        cvVersionId=cv_version_id,
        targetSiteKeys=target_site_keys,
        filters=filters,
        matchThreshold=match_threshold,
        status=Scoutstatus.ACTIVE,
        updatedAt=_now(),
    )
    session.add(scout)
    await session.commit()
    await session.refresh(scout)

    return GetScoutResponse(scout=_scout_response(scout))


@router.get("/scouts/{scout_id}", response_model=GetScoutResponse)
async def get_scout(
    scout_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetScoutResponse:
    scout = await session.get(Scout, scout_id)
    if scout is None or scout.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")
    count = await _relevant_finds_count(session, scout.id, scout.matchThreshold)
    return GetScoutResponse(scout=_scout_response(scout, count))


class UpdateScoutRequest(BaseModel):
    label: Any = None
    cvVersionId: Any = None
    targetSiteKeys: Any = None
    filters: Any = None
    matchThreshold: Any = None
    status: Any = None


@router.patch("/scouts/{scout_id}", response_model=GetScoutResponse)
async def update_scout(
    scout_id: str,
    req: UpdateScoutRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetScoutResponse:
    scout = await session.get(Scout, scout_id)
    if scout is None or scout.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    if scout.status == Scoutstatus.ARCHIVED:
        raise HTTPException(status_code=409, detail="Archived Scouts are read-only")

    provided = req.model_dump(exclude_unset=True)
    if not provided:
        raise HTTPException(status_code=400, detail="Nothing to update")

    if "label" in provided:
        if not isinstance(req.label, str) or not req.label.strip():
            raise HTTPException(status_code=400, detail="label must not be empty")
        scout.label = req.label.strip()

    if "cvVersionId" in provided:
        cv_version_id = _optional_string(req.cvVersionId)
        if not cv_version_id:
            raise HTTPException(status_code=400, detail="cvVersionId must not be empty")
        await _owned_cv_version(session, cv_version_id, user_id)
        scout.cvVersionId = cv_version_id

    if "targetSiteKeys" in provided:
        scout.targetSiteKeys = _normalize_site_keys(req.targetSiteKeys)

    if "filters" in provided:
        scout.filters = _normalize_scout_filters(req.filters)

    if "matchThreshold" in provided:
        scout.matchThreshold = _normalize_threshold(req.matchThreshold)

    if "status" in provided:
        if req.status not in SCOUT_STATUS_VALUES:
            raise HTTPException(
                status_code=400,
                detail=f"status must be one of: {', '.join(SCOUT_STATUS_VALUES)}",
            )
        new_status = Scoutstatus(req.status)
        if (
            new_status == Scoutstatus.ACTIVE
            and scout.status != Scoutstatus.ACTIVE
        ):
            cap = _max_scouts_per_user()
            if await _active_scout_count(session, user_id, exclude_id=scout.id) >= cap:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"You can have at most {cap} active Scouts. "
                        "Pause or archive one before resuming this one."
                    ),
                )
        scout.status = new_status

    scout.updatedAt = _now()
    await session.commit()
    await session.refresh(scout)

    count = await _relevant_finds_count(session, scout.id, scout.matchThreshold)
    return GetScoutResponse(scout=_scout_response(scout, count))


class ScoutFindsResponse(BaseModel):
    relevantFinds: list[AnalysisResponse]
    lowFitFinds: list[AnalysisResponse]


@router.get("/scouts/{scout_id}/finds", response_model=ScoutFindsResponse)
async def list_scout_finds(
    scout_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> ScoutFindsResponse:
    """Completed Analyses this Scout has produced, split by
    `matchScore >= Scout.matchThreshold` into relevant finds and "found — low
    fit" (issue #56). Each row is the same `AnalysisResponse` shape a manual
    analysis uses, so the web client opens the identical gap report."""
    scout = await _owned_scout(session, scout_id, user_id)
    rows = (
        await session.scalars(
            select(Analysis)
            .options(
                selectinload(Analysis.JobOffer_),
                selectinload(Analysis.CVVersion_),
                selectinload(Analysis.IngestionJob_),
            )
            .where(Analysis.scoutId == scout.id, Analysis.status == Analysisstatus.COMPLETED)
            .order_by(Analysis.completedAt.desc())
        )
    ).all()
    relevant = [row for row in rows if (row.matchScore or 0) >= scout.matchThreshold]
    low_fit = [row for row in rows if (row.matchScore or 0) < scout.matchThreshold]
    return ScoutFindsResponse(
        relevantFinds=[_analysis_response(row) for row in relevant],
        lowFitFinds=[_analysis_response(row) for row in low_fit],
    )


# --- Scout runs (issue #54, Scout slice 2) ---
# "Run now" on a Scout creates a ScoutRun row and enqueues `{"scoutRunId": id}`
# on `scout-intake`; the scout worker fans it out to one SITE_SEARCH
# IngestionJob per targeted enabled site. "Run now" is rate-limited to once an
# hour per Scout. GET returns run history / a single run, user-scoped via the
# owning Scout (another user's run is a 404).

SCOUT_RUN_RATE_LIMIT = timedelta(hours=1)


class ScoutRunResponse(BaseModel):
    id: str
    scoutId: str
    status: str
    sitesQueried: int
    siteUnavailableCount: int
    offersDiscovered: int
    offersAnalysed: int
    relevantCount: int
    failedCount: int
    alreadySeenCount: int
    runLimitSkippedCount: int
    capSkippedCount: int
    errorMessage: str | None
    startedAt: datetime | None
    finishedAt: datetime | None
    createdAt: datetime


def _scout_run_response(row: ScoutRun) -> ScoutRunResponse:
    return ScoutRunResponse(
        id=row.id,
        scoutId=row.scoutId,
        status=row.status.value,
        sitesQueried=row.sitesQueried,
        siteUnavailableCount=row.siteUnavailableCount,
        offersDiscovered=row.offersDiscovered,
        offersAnalysed=row.offersAnalysed,
        relevantCount=row.relevantCount,
        failedCount=row.failedCount,
        alreadySeenCount=row.alreadySeenCount,
        runLimitSkippedCount=row.runLimitSkippedCount,
        capSkippedCount=row.capSkippedCount,
        errorMessage=row.errorMessage,
        startedAt=row.startedAt,
        finishedAt=row.finishedAt,
        createdAt=row.createdAt,
    )


class ScoutRunListResponse(BaseModel):
    scoutRuns: list[ScoutRunResponse]


class GetScoutRunResponse(BaseModel):
    scoutRun: ScoutRunResponse


async def _owned_scout(session: AsyncSession, scout_id: str, user_id: str) -> Scout:
    scout = await session.get(Scout, scout_id)
    if scout is None or scout.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")
    return scout


@router.post(
    "/scouts/{scout_id}/run", response_model=GetScoutRunResponse, status_code=201
)
async def run_scout(
    scout_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetScoutRunResponse:
    scout = await _owned_scout(session, scout_id, user_id)
    if scout.status == Scoutstatus.ARCHIVED:
        raise HTTPException(status_code=409, detail="Archived Scouts cannot be run")

    latest = (
        await session.scalars(
            select(ScoutRun)
            .where(ScoutRun.scoutId == scout.id)
            .order_by(ScoutRun.createdAt.desc())
            .limit(1)
        )
    ).first()
    if latest is not None and latest.createdAt > _now() - SCOUT_RUN_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="This Scout ran within the last hour. Try again later.",
        )

    scout_run = ScoutRun(
        id=str(uuid.uuid4()),
        scoutId=scout.id,
        status=Scoutrunstatus.PENDING,
    )
    session.add(scout_run)
    await session.commit()
    await session.refresh(scout_run)

    sqs = make_sqs_client()
    sqs.send_message(
        QueueUrl=SCOUT_INTAKE_QUEUE_URL,
        MessageBody=json.dumps({"scoutRunId": scout_run.id}),
    )

    return GetScoutRunResponse(scoutRun=_scout_run_response(scout_run))


@router.get("/scouts/{scout_id}/runs", response_model=ScoutRunListResponse)
async def list_scout_runs(
    scout_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> ScoutRunListResponse:
    scout = await _owned_scout(session, scout_id, user_id)
    rows = (
        await session.scalars(
            select(ScoutRun)
            .where(ScoutRun.scoutId == scout.id)
            .order_by(ScoutRun.createdAt.desc())
        )
    ).all()
    return ScoutRunListResponse(scoutRuns=[_scout_run_response(row) for row in rows])


@router.get("/scout-runs/{run_id}", response_model=GetScoutRunResponse)
async def get_scout_run(
    run_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> GetScoutRunResponse:
    run = await session.get(ScoutRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Not found")
    await _owned_scout(session, run.scoutId, user_id)
    return GetScoutRunResponse(scoutRun=_scout_run_response(run))
