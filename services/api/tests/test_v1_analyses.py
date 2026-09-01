import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    IngestionJob,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete

from api.main import app
from api.sqs_client import ANALYSIS_INTAKE_QUEUE_URL, make_sqs_client

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
    # Analysis/CVVersion.userId both have ondelete=CASCADE, so this also
    # removes any rows created for the user during the test.
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _create_job_offer() -> str:
    job_offer_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                JobOffer(
                    id=job_offer_id,
                    sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                    sourceSite=Joboffersourcesite.OTHER,
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


async def _create_cv_version(user_id: str) -> str:
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
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return cv_version_id


def _purge_queue() -> None:
    sqs = make_sqs_client()
    while True:
        received = sqs.receive_message(QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, MaxNumberOfMessages=10)
        messages = received.get("Messages", [])
        if not messages:
            break
        for message in messages:
            sqs.delete_message(QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"])


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


@pytest.fixture
def job_offer_id():
    jid = asyncio.run(_create_job_offer())
    yield jid
    asyncio.run(_delete_job_offer(jid))


@pytest.fixture
def cv_version_id(user_id):
    return asyncio.run(_create_cv_version(user_id))


@pytest.fixture(autouse=True)
def _clean_queue():
    _purge_queue()
    yield
    _purge_queue()


def test_create_analysis_requires_user_id_header(job_offer_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyses",
            headers=INTERNAL_SECRET_HEADERS,
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert response.status_code == 401


def test_create_analysis_rejects_unknown_job_offer(user_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": str(uuid.uuid4()), "cvVersionId": cv_version_id},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown jobOfferId"


def test_create_analysis_rejects_cv_version_owned_by_another_user(job_offer_id, user_id):
    other_user_id = asyncio.run(_create_user())
    other_cv_version_id = asyncio.run(_create_cv_version(other_user_id))
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/analyses",
                headers=_headers(user_id),
                json={"jobOfferId": job_offer_id, "cvVersionId": other_cv_version_id},
            )
        assert response.status_code == 400
        assert response.json()["detail"] == "Unknown cvVersionId"
    finally:
        asyncio.run(_delete_user(other_user_id))


def test_create_analysis_success_creates_row_and_enqueues_sqs_message(user_id, job_offer_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert response.status_code == 202
    analysis_id = response.json()["analysisId"]
    assert analysis_id

    sqs = make_sqs_client()
    received = sqs.receive_message(QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=2)
    messages = received.get("Messages", [])
    assert len(messages) == 1
    assert json.loads(messages[0]["Body"]) == {"analysisId": analysis_id}


def test_create_analysis_returns_429_once_daily_cap_reached(monkeypatch, user_id, job_offer_id, cv_version_id):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "1")
    with TestClient(app) as client:
        first = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        assert first.status_code == 202

        second = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert second.status_code == 429
    assert "Daily analysis limit of 1 reached" in second.json()["detail"]


def test_get_analyses_quota_requires_user_id_header():
    with TestClient(app) as client:
        response = client.get("/v1/analyses/quota", headers=INTERNAL_SECRET_HEADERS)
    assert response.status_code == 401


def test_get_analyses_quota_reports_cap_used_and_remaining(
    monkeypatch, user_id, job_offer_id, cv_version_id
):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "3")
    with TestClient(app) as client:
        before = client.get("/v1/analyses/quota", headers=_headers(user_id))
        assert before.status_code == 200
        assert before.json()["quota"] == {"cap": 3, "used": 0, "remaining": 3}

        posted = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        assert posted.status_code == 202

        after = client.get("/v1/analyses/quota", headers=_headers(user_id))
        assert after.json()["quota"] == {"cap": 3, "used": 1, "remaining": 2}

        other_user_id = asyncio.run(_create_user())
        try:
            other = client.get("/v1/analyses/quota", headers=_headers(other_user_id))
            assert other.json()["quota"] == {"cap": 3, "used": 0, "remaining": 3}
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_get_analyses_quota_never_negative_remaining(
    monkeypatch, user_id, job_offer_id, cv_version_id
):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "1")
    with TestClient(app) as client:
        client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        quota = client.get("/v1/analyses/quota", headers=_headers(user_id)).json()["quota"]
    assert quota == {"cap": 1, "used": 1, "remaining": 0}


def test_list_and_get_analyses_scoped_to_caller(user_id, job_offer_id, cv_version_id):
    with TestClient(app) as client:
        created = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()
        analysis_id = created["analysisId"]

        list_response = client.get("/v1/analyses", headers=_headers(user_id))
        assert list_response.status_code == 200
        analyses = list_response.json()["analyses"]
        assert len(analyses) == 1
        assert analyses[0]["id"] == analysis_id
        assert analyses[0]["status"] == "PENDING"
        assert analyses[0]["jobOffer"]["id"] == job_offer_id
        assert analyses[0]["cvVersion"]["id"] == cv_version_id

        filtered_response = client.get(
            "/v1/analyses", headers=_headers(user_id), params={"jobOfferId": job_offer_id}
        )
        assert filtered_response.status_code == 200
        assert len(filtered_response.json()["analyses"]) == 1

        get_response = client.get(f"/v1/analyses/{analysis_id}", headers=_headers(user_id))
        assert get_response.status_code == 200
        assert get_response.json()["analysis"]["id"] == analysis_id

        other_user_id = asyncio.run(_create_user())
        try:
            other_list = client.get("/v1/analyses", headers=_headers(other_user_id))
            assert other_list.json()["analyses"] == []

            other_get = client.get(f"/v1/analyses/{analysis_id}", headers=_headers(other_user_id))
            assert other_get.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


async def _link_analysis_to_new_ingestion_job(user_id: str, analysis_id: str) -> str:
    """Creates an IngestionJob owned by `user_id` and stamps its id onto
    `analysis_id`'s ingestionJobId (the worker does this in the real flow)."""
    ingestion_job_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                IngestionJob(
                    id=ingestion_job_id,
                    userId=user_id,
                    mode=Ingestionmode.SINGLE_URL,
                    maxOffers=1,
                    status=Ingestionjobstatus.PENDING,
                    updatedAt=_now(),
                )
            )
            analysis = await session.get(Analysis, analysis_id)
            analysis.ingestionJobId = ingestion_job_id
            await session.commit()
    finally:
        await engine.dispose()
    return ingestion_job_id


def test_list_analyses_filters_by_ingestion_job_id(user_id, job_offer_id, cv_version_id):
    with TestClient(app) as client:
        batched_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]
        standalone_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]

        ingestion_job_id = asyncio.run(_link_analysis_to_new_ingestion_job(user_id, batched_id))

        filtered = client.get(
            "/v1/analyses",
            headers=_headers(user_id),
            params={"ingestionJobId": ingestion_job_id},
        )
        assert filtered.status_code == 200
        ids = [a["id"] for a in filtered.json()["analyses"]]
        assert ids == [batched_id]
        assert standalone_id not in ids

        other_user_id = asyncio.run(_create_user())
        try:
            other = client.get(
                "/v1/analyses",
                headers=_headers(other_user_id),
                params={"ingestionJobId": ingestion_job_id},
            )
            assert other.json()["analyses"] == []
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_get_analysis_returns_404_for_unknown_id(user_id):
    with TestClient(app) as client:
        response = client.get(f"/v1/analyses/{uuid.uuid4()}", headers=_headers(user_id))
    assert response.status_code == 404
