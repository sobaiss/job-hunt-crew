import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="job-hunt-crew api")

INTERNAL_API_SECRET_HEADER = "x-internal-api-secret"


@app.middleware("http")
async def enforce_internal_api_secret(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)

    expected = os.environ.get("INTERNAL_API_SECRET")
    provided = request.headers.get(INTERNAL_API_SECRET_HEADER)
    if not expected or provided != expected:
        return JSONResponse(
            status_code=401,
            content={"detail": "Missing or invalid internal API secret"},
        )
    return await call_next(request)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
