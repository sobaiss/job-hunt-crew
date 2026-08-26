from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from py_db.models import SiteConfig
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session

router = APIRouter(prefix="/v1")


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
