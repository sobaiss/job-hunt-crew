from fastapi import APIRouter, Depends, Header, HTTPException
from py_db.models import Plan
from pydantic import BaseModel

router = APIRouter(prefix="/v1/admin")


async def require_admin(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_plan: str | None = Header(default=None, alias="X-User-Plan"),
) -> str:
    """Rejects any caller whose forwarded Plan isn't ADMINISTRATEUR (issue
    #138). Trusts the BFF-forwarded X-User-Plan header the same way
    `require_user_id` trusts X-User-Id — no independent re-verification
    against Postgres, same MVP boundary as the Internal API secret.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header")
    if x_user_plan != Plan.ADMINISTRATEUR.value:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return x_user_id


class AdminMeResponse(BaseModel):
    userId: str
    plan: str


@router.get("/me", response_model=AdminMeResponse)
async def admin_me(user_id: str = Depends(require_admin)) -> AdminMeResponse:
    """Backs the bare `/admin` landing page (issue #138) — confirms the
    caller actually cleared `require_admin`. #139/#140 add the real
    per-user and reporting endpoints behind this same dependency.
    """
    return AdminMeResponse(userId=user_id, plan=Plan.ADMINISTRATEUR.value)
