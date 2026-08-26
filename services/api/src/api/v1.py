import math
import os
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from py_db.models import (
    CVVersion,
    Cvfiletype,
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    SiteConfig,
)
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .db import get_session
from .s3_client import S3_BUCKET, cv_file_key, make_s3_client

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
}

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
    parseStatus: str
    structuredData: dict[str, Any] | None
    structuredDataVer: int | None
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
        parseStatus=row.parseStatus.value,
        structuredData=row.structuredData,
        structuredDataVer=row.structuredDataVer,
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

    file_type = CONTENT_TYPE_TO_FILE_TYPE.get(content_type)
    if file_type is None:
        raise HTTPException(
            status_code=400, detail="Unsupported file type; only PDF and DOCX are supported"
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


# --- Ingestion jobs (M7-T11) ---
# Ports apps/web/app/api/ingestion-jobs/{route.ts,[id]/route.ts}'s mode/filter
# validation and INGESTION_MAX_OFFERS default verbatim (PRD Section 8.5, 11/13).
# Only Mode 3 (SITE_SEARCH) has a trigger endpoint today; per M7-T11, this port
# preserves the pre-existing gap as-is — it only creates the IngestionJob row,
# it does not wire in scraping/extraction.

POSTED_WITHIN_VALUES = ("24h", "7d", "14d", "30d", "any")
REMOTE_VALUES = ("onsite", "hybrid", "remote")

DEFAULT_MAX_OFFERS = 25


def _ingestion_max_offers() -> int:
    raw = os.environ.get("INGESTION_MAX_OFFERS")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_MAX_OFFERS


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
    siteConfigId: Any = None
    filters: dict[str, Any] | None = None


class CreateIngestionJobResponse(BaseModel):
    ingestionJob: IngestionJobResponse


@router.post("/ingestion-jobs", response_model=CreateIngestionJobResponse, status_code=201)
async def create_ingestion_job(
    req: CreateIngestionJobRequest,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> CreateIngestionJobResponse:
    if req.mode != "SITE_SEARCH":
        raise HTTPException(status_code=400, detail="mode must be SITE_SEARCH")

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

    ingestion_job = IngestionJob(
        id=str(uuid.uuid4()),
        userId=user_id,
        mode=Ingestionmode.SITE_SEARCH,
        siteConfigId=site_config_id,
        filters=filters,
        maxOffers=_ingestion_max_offers(),
        status=Ingestionjobstatus.PENDING,
        updatedAt=_now(),
    )
    session.add(ingestion_job)
    await session.commit()
    await session.refresh(ingestion_job)

    return CreateIngestionJobResponse(ingestionJob=_ingestion_job_response(ingestion_job))


@router.get("/ingestion-jobs/{ingestion_job_id}", response_model=IngestionJobDetailResponse)
async def get_ingestion_job(
    ingestion_job_id: str,
    user_id: str = Depends(require_user_id),
    session: AsyncSession = Depends(get_session),
) -> IngestionJobDetailResponse:
    stmt = (
        select(IngestionJob)
        .options(selectinload(IngestionJob.IngestionJobOffer).selectinload(IngestionJobOffer.JobOffer_))
        .where(IngestionJob.id == ingestion_job_id)
    )
    ingestion_job = (await session.scalars(stmt)).first()
    if ingestion_job is None or ingestion_job.userId != user_id:
        raise HTTPException(status_code=404, detail="Not found")

    return _ingestion_job_detail_response(ingestion_job)
