import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete

from api.main import app

INTERNAL_SECRET_HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def _headers(user_id: str) -> dict[str, str]:
    return {**INTERNAL_SECRET_HEADERS, "X-User-Id": user_id}


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _create_user() -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            await session.commit()
    finally:
        await engine.dispose()
    return user_id


async def _delete_user(user_id: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _create_job_offer(source_url: str, status: Jobofferextractionstatus) -> str:
    job_offer_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                JobOffer(
                    id=job_offer_id,
                    sourceUrl=source_url,
                    sourceSite=Joboffersourcesite.OTHER,
                    extractionStatus=status,
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return job_offer_id


async def _delete_job_offer(job_offer_id: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(JobOffer).where(JobOffer.id == job_offer_id))
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


def test_lookup_job_offer_requires_user_id_header():
    with TestClient(app) as client:
        response = client.get(
            "/v1/job-offers",
            headers=INTERNAL_SECRET_HEADERS,
            params={"url": "https://example.com/jobs/1"},
        )
    assert response.status_code == 401


def test_lookup_job_offer_requires_url(user_id):
    with TestClient(app) as client:
        response = client.get("/v1/job-offers", headers=_headers(user_id))
    assert response.status_code == 400


def test_lookup_job_offer_returns_null_for_unknown_url(user_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/job-offers",
            headers=_headers(user_id),
            params={"url": f"https://example.com/jobs/{uuid.uuid4()}"},
        )
    assert response.status_code == 200
    assert response.json() == {"jobOffer": None}


def test_lookup_job_offer_returns_the_matching_offer(user_id):
    source_url = f"https://example.com/jobs/{uuid.uuid4()}"
    job_offer_id = asyncio.run(
        _create_job_offer(source_url, Jobofferextractionstatus.READY)
    )
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/job-offers",
                headers=_headers(user_id),
                params={"url": source_url},
            )
        assert response.status_code == 200
        body = response.json()["jobOffer"]
        assert body["id"] == job_offer_id
        assert body["sourceUrl"] == source_url
        assert body["extractionStatus"] == "READY"
    finally:
        asyncio.run(_delete_job_offer(job_offer_id))
