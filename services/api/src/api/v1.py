import math
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from py_db.models import CVVersion, Cvfiletype, SiteConfig
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

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
