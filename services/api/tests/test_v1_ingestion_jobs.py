import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import CVVersion, Cvconversionstatus, Cvfiletype, SiteConfig, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app
from api.sqs_client import INGESTION_INTAKE_QUEUE_URL, make_sqs_client

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


async def _create_cv_version(user_id: str, *, converted: bool = True) -> str:
    cv_version_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                CVVersion(
                    id=cv_version_id,
                    userId=user_id,
                    label="Test CV",
                    fileKey=f"cvs/{user_id}/{cv_version_id}/cv.pdf",
                    fileName="cv.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=1024,
                    conversionStatus=(
                        Cvconversionstatus.CONVERTED if converted else Cvconversionstatus.PENDING
                    ),
                    updatedAt=datetime.now(UTC).replace(tzinfo=None),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return cv_version_id


def _purge_ingestion_intake_queue() -> None:
    sqs = make_sqs_client()
    while True:
        received = sqs.receive_message(
            QueueUrl=INGESTION_INTAKE_QUEUE_URL, MaxNumberOfMessages=10
        )
        messages = received.get("Messages", [])
        if not messages:
            break
        for message in messages:
            sqs.delete_message(
                QueueUrl=INGESTION_INTAKE_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"]
            )


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


@pytest.fixture
def cv_version_id(user_id):
    return asyncio.run(_create_cv_version(user_id))


@pytest.fixture(autouse=True)
def _clean_ingestion_intake_queue():
    _purge_ingestion_intake_queue()
    yield
    _purge_ingestion_intake_queue()


def test_create_ingestion_job_requires_user_id_header(site_config_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=INTERNAL_SECRET_HEADERS,
            json={"mode": "SITE_SEARCH", "siteConfigId": site_config_id},
        )
    assert response.status_code == 401


def test_create_ingestion_job_rejects_unsupported_mode(user_id, site_config_id):
    # LISTING_URL stays a valid enum value in the DB but no screen produces it,
    # so the endpoint rejects it (matching flow #27).
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "LISTING_URL", "siteConfigId": site_config_id},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "mode must be SINGLE_URL or SITE_SEARCH"


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


def test_create_ingestion_job_success_uses_configured_max_offers(
    monkeypatch, user_id, site_config_id, cv_version_id
):
    monkeypatch.setenv("INGESTION_MAX_OFFERS", "7")
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": cv_version_id,
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
    assert ingestion_job["cvVersionId"] == cv_version_id
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


def test_create_ingestion_job_defaults_max_offers_to_25(user_id, site_config_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": cv_version_id,
            },
        )
    assert response.status_code == 201
    assert response.json()["ingestionJob"]["maxOffers"] == 25


def test_create_site_search_ingestion_job_clamps_max_offers_from_body_and_enqueues(
    user_id, site_config_id, cv_version_id
):
    with TestClient(app) as client:
        clamped_high = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": cv_version_id,
                "maxOffers": 999,
            },
        )
        assert clamped_high.status_code == 201
        job = clamped_high.json()["ingestionJob"]
        assert job["maxOffers"] == 25

        clamped_low = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": cv_version_id,
                "maxOffers": 0,
            },
        )
        assert clamped_low.status_code == 201
        assert clamped_low.json()["ingestionJob"]["maxOffers"] == 1

        in_range = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": cv_version_id,
                "maxOffers": 3,
            },
        )
        assert in_range.status_code == 201
        job = in_range.json()["ingestionJob"]
        assert job["maxOffers"] == 3

    sqs = make_sqs_client()
    ids = set()
    while True:
        received = sqs.receive_message(
            QueueUrl=INGESTION_INTAKE_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=1
        )
        messages = received.get("Messages", [])
        if not messages:
            break
        for message in messages:
            ids.add(json.loads(message["Body"])["ingestionJobId"])
    assert job["id"] in ids


def test_create_ingestion_job_rejects_missing_cv_version_id(user_id, site_config_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "SITE_SEARCH", "siteConfigId": site_config_id},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "cvVersionId is required"


def test_create_ingestion_job_rejects_cv_version_owned_by_another_user(user_id, site_config_id):
    other_user_id = asyncio.run(_create_user())
    other_cv_version_id = asyncio.run(_create_cv_version(other_user_id))
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/ingestion-jobs",
                headers=_headers(user_id),
                json={
                    "mode": "SITE_SEARCH",
                    "siteConfigId": site_config_id,
                    "cvVersionId": other_cv_version_id,
                },
            )
        assert response.status_code == 400
        assert response.json()["detail"] == "Unknown cvVersionId"
    finally:
        asyncio.run(_delete_user(other_user_id))


def test_create_ingestion_job_rejects_unconverted_cv_version(user_id, site_config_id):
    pending_cv_id = asyncio.run(_create_cv_version(user_id, converted=False))
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": pending_cv_id,
            },
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "cvVersionId must reference a CONVERTED CV"


def test_create_single_url_ingestion_job_requires_input_url(user_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={"mode": "SINGLE_URL", "cvVersionId": cv_version_id},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "inputUrl is required for SINGLE_URL"


def test_create_single_url_ingestion_job_forces_max_offers_1_and_enqueues(user_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SINGLE_URL",
                "cvVersionId": cv_version_id,
                "inputUrl": "https://example.com/jobs/12345",
                "maxOffers": 25,
            },
        )
    assert response.status_code == 201
    job = response.json()["ingestionJob"]
    assert job["mode"] == "SINGLE_URL"
    assert job["inputUrl"] == "https://example.com/jobs/12345"
    assert job["cvVersionId"] == cv_version_id
    assert job["siteConfigId"] is None
    assert job["maxOffers"] == 1
    assert job["status"] == "PENDING"
    assert job["quotaSkippedCount"] == 0

    sqs = make_sqs_client()
    received = sqs.receive_message(
        QueueUrl=INGESTION_INTAKE_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=2
    )
    messages = received.get("Messages", [])
    assert len(messages) == 1
    assert json.loads(messages[0]["Body"]) == {"ingestionJobId": job["id"]}


def test_get_ingestion_job_returns_job_offers_and_enforces_ownership(
    user_id, site_config_id, cv_version_id
):
    with TestClient(app) as client:
        created = client.post(
            "/v1/ingestion-jobs",
            headers=_headers(user_id),
            json={
                "mode": "SITE_SEARCH",
                "siteConfigId": site_config_id,
                "cvVersionId": cv_version_id,
            },
        ).json()["ingestionJob"]

        get_response = client.get(f"/v1/ingestion-jobs/{created['id']}", headers=_headers(user_id))
        assert get_response.status_code == 200
        body = get_response.json()["ingestionJob"]
        assert body["id"] == created["id"]
        assert body["jobOffers"] == []
        # New IngestionJob row starts with no quota-skipped offers (issue #33).
        assert body["quotaSkippedCount"] == 0

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
