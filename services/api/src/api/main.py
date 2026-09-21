import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from py_db.session import make_engine, make_session_factory

from .admin import router as admin_router
from .admin_llm_provider_settings import (
    ROUTE_PREFIX as ADMIN_LLM_PROVIDER_SETTINGS_PREFIX,
)
from .admin_llm_provider_settings import (
    request_validation_error_without_input,
    router as admin_llm_provider_settings_router,
)
from .internal import router as internal_router
from .v1 import router as v1_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Built here (not at import time) so the async engine/connection pool is
    # bound to the event loop this app instance actually runs on — creating
    # it at import time would bind asyncpg's pool to whatever loop happened
    # to be current then, which breaks under test runners that spin up a
    # fresh loop per app/TestClient lifecycle.
    engine = make_engine()
    app.state.session_factory = make_session_factory(engine)
    yield
    await engine.dispose()


app = FastAPI(title="job-hunt-crew api", lifespan=lifespan)
app.include_router(internal_router)
app.include_router(v1_router)
app.include_router(admin_router)
app.include_router(admin_llm_provider_settings_router)


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(request: Request, exc: RequestValidationError):
    # These routes take API keys in the body, and FastAPI's default 422 echoes
    # the offending input. Every other route keeps the framework's default.
    if request.url.path.startswith(ADMIN_LLM_PROVIDER_SETTINGS_PREFIX):
        return await request_validation_error_without_input(request, exc)
    return await request_validation_exception_handler(request, exc)


INTERNAL_API_SECRET_HEADER = "x-internal-api-secret"
# Only these three paths (FastAPI's auto-generated docs) are ever exempt from
# the secret check, and only when ENVIRONMENT=development — unset/anything
# else stays locked down, so a misconfigured deploy fails closed rather than
# open.
DOCS_PATHS = {"/docs", "/redoc", "/openapi.json"}


@app.middleware("http")
async def enforce_internal_api_secret(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)

    if request.url.path in DOCS_PATHS and os.environ.get("ENVIRONMENT") == "development":
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
