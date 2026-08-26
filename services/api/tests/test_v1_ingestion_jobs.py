import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import SiteConfig, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app

INTERNAL_SECRET_HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def _headers(user_id: str) -> dict[str, str]:
    return {**INTERNAL_SECRET_HEADERS, "X-User-Id": user_id}


async def _create_user() -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                User(
                    id=user_id,
                    email=f"{user_id}@example.com",
                    updatedAt=datetime.now(UTC).replace(tzinfo=None),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return user_id


async def _delete_user(user_id: str) -> None:
    # IngestionJob.userId has ondelete=CASCADE, so this also removes any rows
    # created for the user during the test.
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _an_enabled_site_config_id() -> str:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            row = (
                await session.scalars(select(SiteConfig).where(SiteConfig.enabled.is_(True)).limit(1))
            ).first()
            assert row is not None, "expected at least one seeded enabled SiteConfig"
            return row.id
    finally:
        await engine.dispose()


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


@pytest.fixture
def site_config_id():
    return asyncio.run(_an_enabled_site_config_id())


def test_create_ingestion_job_requires_user_id_header(site_config_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=INTERNAL_SECRET_HEADERS,
            json={"mode": "SITE_SEARCH", "siteConfigId": site_config_id},
        )
    assert response.status_code == 401


def test_create_ingestion_job_rejects_unsupported_mode(user_id, site_config_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "LISTING_URL", "siteConfigId": site_config_id},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "mode must be SITE_SEARCH"


def test_create_ingestion_job_rejects_missing_site_config_id(user_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "SITE_SEARCH"},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "siteConfigId is required"


def test_create_ingestion_job_rejects_disabled_or_unknown_site_config(user_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "SITE_SEARCH", "siteConfigId": str(uuid.uuid4())},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown or disabled siteConfigId"


def test_create_ingestion_job_rejects_bad_filter_values(user_id, site_config_id):
    with TestClient(app) as client:
        bad_posted_within = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "filters": {"postedWithin": "999d"},
            },
        )
        assert bad_posted_within.status_code == 400
        assert "filters.postedWithin must be one of" in bad_posted_within.json()["detail"]

        bad_remote = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "filters": {"remote": "space"},
            },
        )
        assert bad_remote.status_code == 400
        assert "filters.remote must be one of" in bad_remote.json()["detail"]


def test_create_ingestion_job_success_uses_configured_max_offers(monkeypatch, user_id, site_config_id):
    monkeypatch.setenv("INGESTION_MAX_OFFERS", "7")
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "filters": {
                    "keywords": "python",
                    "location": "Paris",
                    "postedWithin": "7d",
                    "contractType": "CDI",
                    "remote": "hybrid",
                    "experienceLevel": "senior",
                },
            },
        )
    assert response.status_code == 201
    ingestion_job = response.json()["ingestionJob"]
    assert ingestion_job["userId"] == user_id
    assert ingestion_job["mode"] == "SITE_SEARCH"
    assert ingestion_job["siteConfigId"] == site_config_id
    assert ingestion_job["status"] == "PENDING"
    assert ingestion_job["maxOffers"] == 7
    assert ingestion_job["filters"] == {
        "keywords": "python",
        "location": "Paris",
        "postedWithin": "7d",
        "contractType": "CDI",
        "remote": "hybrid",
        "experienceLevel": "senior",
    }


def test_create_ingestion_job_defaults_max_offers_to_25(user_id, site_config_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "SITE_SEARCH", "siteConfigId": site_config_id},
        )
    assert response.status_code == 201
    assert response.json()["ingestionJob"]["maxOffers"] == 25


def test_get_ingestion_job_returns_job_offers_and_enforces_ownership(user_id, site_config_id):
    with TestClient(app) as client:
        created = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "SITE_SEARCH", "siteConfigId": site_config_id},
        ).json()["ingestionJob"]

        get_response = client.get(f"/v1/ingestion-jobs/{created['id']}", headers=_headers(user_id))
        assert get_response.status_code == 200
        body = get_response.json()
        assert body["id"] == created["id"]
        assert body["jobOffers"] == []

        other_user_id = asyncio.run(_create_user())
        try:
            other_response = client.get(
                f"/v1/ingestion-jobs/{created['id']}", headers=_headers(other_user_id)
            )
            assert other_response.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_get_ingestion_job_returns_404_for_unknown_id(user_id):
    with TestClient(app) as client:
        response = client.get(f"/v1/ingestion-jobs/{uuid.uuid4()}", headers=_headers(user_id))
    assert response.status_code == 404
