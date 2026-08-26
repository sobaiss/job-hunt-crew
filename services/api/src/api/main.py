from fastapi import FastAPI

app = FastAPI(title="job-hunt-crew api")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
