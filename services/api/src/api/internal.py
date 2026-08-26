import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from py_db.models import User, t_VerificationToken
from pydantic import BaseModel
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session

router = APIRouter(prefix="/internal")


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def _naive(dt: datetime) -> datetime:
    return dt.astimezone(UTC).replace(tzinfo=None) if dt.tzinfo else dt


class UpsertUserRequest(BaseModel):
    email: str
    name: str | None = None
    image: str | None = None


class UpsertUserResponse(BaseModel):
    userId: str


@router.post("/users/upsert", response_model=UpsertUserResponse)
async def upsert_user(
    req: UpsertUserRequest, session: AsyncSession = Depends(get_session)
) -> UpsertUserResponse:
    """Backs NextAuth's sign-in callback (M7-T5): called once per sign-in so
    the frontend can embed the canonical Postgres userId in the JWT without
    ever touching Postgres directly. Same email twice must return the same
    userId (idempotent upsert), matching this task's verification.
    """
    user = await session.scalar(select(User).where(User.email == req.email))
    if user is None:
        user = User(
            id=str(uuid.uuid4()),
            email=req.email,
            name=req.name,
            image=req.image,
            updatedAt=_now(),
        )
        session.add(user)
    else:
        if req.name is not None:
            user.name = req.name
        if req.image is not None:
            user.image = req.image
        user.updatedAt = _now()
    await session.commit()
    return UpsertUserResponse(userId=user.id)


class VerificationTokenRequest(BaseModel):
    identifier: str
    token: str
    expires: datetime


class VerificationTokenResponse(BaseModel):
    identifier: str
    token: str
    expires: datetime


@router.post(
    "/auth/verification-tokens",
    response_model=VerificationTokenResponse,
    status_code=201,
)
async def create_verification_token(
    req: VerificationTokenRequest, session: AsyncSession = Depends(get_session)
) -> VerificationTokenResponse:
    """Backs Adapter.createVerificationToken for NextAuth's Email (magic-link)
    provider (M7-T5)."""
    expires = _naive(req.expires)
    await session.execute(
        insert(t_VerificationToken).values(
            identifier=req.identifier, token=req.token, expires=expires
        )
    )
    await session.commit()
    return VerificationTokenResponse(identifier=req.identifier, token=req.token, expires=expires)


class ConsumeVerificationTokenRequest(BaseModel):
    identifier: str
    token: str


@router.post(
    "/auth/verification-tokens/consume",
    response_model=VerificationTokenResponse,
)
async def consume_verification_token(
    req: ConsumeVerificationTokenRequest, session: AsyncSession = Depends(get_session)
) -> VerificationTokenResponse:
    """Backs Adapter.useVerificationToken (M7-T5). A single DELETE ...
    RETURNING makes consumption atomically single-use: a second consume of
    the same (identifier, token) pair finds no row left to delete.
    """
    result = await session.execute(
        delete(t_VerificationToken)
        .where(
            t_VerificationToken.c.identifier == req.identifier,
            t_VerificationToken.c.token == req.token,
        )
        .returning(
            t_VerificationToken.c.identifier,
            t_VerificationToken.c.token,
            t_VerificationToken.c.expires,
        )
    )
    row = result.first()
    await session.commit()
    if row is None:
        raise HTTPException(
            status_code=404, detail="Verification token not found or already consumed"
        )
    return VerificationTokenResponse(identifier=row.identifier, token=row.token, expires=row.expires)
