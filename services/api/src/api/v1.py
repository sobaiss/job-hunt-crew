import json
import math
import os
import uuid
from datetime import UTC, datetime
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
    SiteConfig,
)
from py_db.quota import analyses_requested_today, daily_analysis_cap
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .db import get_session
from .s3_client import S3_BUCKET, cv_file_key, make_s3_client
from .sqs_client import (
    ANALYSIS_INTAKE_QUEUE_URL,
    CV_CONVERSION_QUEUE_URL,
    INGESTION_INTAKE_QUEUE_URL,
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


class AnalysisResponse(BaseModel):
    id: str
    userId: str
    jobOfferId: str
    cvVersionId: str
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


def _analysis_response(row: Analysis) -> AnalysisResponse:
    return AnalysisResponse(
        id=row.id,
        userId=row.userId,
        jobOfferId=row.jobOfferId,
        cvVersionId=row.cvVersionId,
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
        .options(selectinload(Analysis.JobOffer_), selectinload(Analysis.CVVersion_))
        .where(Analysis.userId == user_id)
        .order_by(Analysis.requestedAt.desc())
    )
    if jobOfferId:
        stmt = stmt.where(Analysis.jobOfferId == jobOfferId)
    if ingestionJobId:
        stmt = stmt.where(Analysis.ingestionJobId == ingestionJobId)
    rows = (await session.scalars(stmt)).all()
    return AnalysisListResponse(analyses=[_analysis_response(row) for row in rows])


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
        .options(selectinload(Analysis.JobOffer_), selectinload(Analysis.CVVersion_))
        .where(Analysis.id == analysis_id)
    )
    analysis = (await session.scalars(stmt)).first()
    if analysis is None or analysis.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    return GetAnalysisResponse(analysis=_analysis_response(analysis))
