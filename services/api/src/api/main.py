import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from py_db.session import make_engine, make_session_factory

from .internal import router as internal_router


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
