import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete

from api.main import app
from api.sqs_client import SCOUT_INTAKE_QUEUE_URL, make_sqs_client

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
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


def _drain_scout_intake() -> list[dict]:
    sqs = make_sqs_client()
    bodies: list[dict] = []
    while True:
        received = sqs.receive_message(QueueUrl=SCOUT_INTAKE_QUEUE_URL, MaxNumberOfMessages=10)
        messages = received.get("Messages", [])
        if not messages:
            break
        for message in messages:
            bodies.append(json.loads(message["Body"]))
            sqs.delete_message(
                QueueUrl=SCOUT_INTAKE_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"]
            )
    return bodies


@pytest.fixture(autouse=True)
def _clean_scout_intake_queue():
    _drain_scout_intake()
    yield
    _drain_scout_intake()


def _make_cv_version(client: TestClient, user_id: str) -> str:
    response = client.post(
        "/v1/cv-versions",
        headers=_headers(user_id),
        json={
            "label": "Base CV",
            "fileName": "cv.pdf",
            "contentType": "application/pdf",
            "fileSizeBytes": 1024,
        },
    )
    assert response.status_code == 201
    return response.json()["cvVersionId"]


def _make_scout(client: TestClient, user_id: str) -> str:
    response = client.post(
        "/v1/scouts",
        headers=_headers(user_id),
        json={
            "label": "Senior Backend — Remote EU",
            "cvVersionId": _make_cv_version(client, user_id),
            "targetSiteKeys": ["FRANCE_TRAVAIL"],
            "filters": {"keywords": "python", "postedWithin": "7d"},
        },
    )
    assert response.status_code == 201
    return response.json()["scout"]["id"]


def test_run_scout_creates_pending_run_and_enqueues_scout_intake(user_id):
    with TestClient(app) as client:
        scout_id = _make_scout(client, user_id)
        response = client.post(f"/v1/scouts/{scout_id}/run", headers=_headers(user_id))
        assert response.status_code == 201
        run = response.json()["scoutRun"]
        assert run["status"] == "PENDING"
        assert run["scoutId"] == scout_id
        assert run["sitesQueried"] == 0
        # Cost-bounded matching counts (issue #55) start at 0 like the rest.
        assert run["alreadySeenCount"] == 0
        assert run["runLimitSkippedCount"] == 0
        assert run["capSkippedCount"] == 0

    bodies = _drain_scout_intake()
    assert bodies == [{"scoutRunId": run["id"]}]


def test_run_scout_is_rate_limited_to_once_per_hour(user_id):
    with TestClient(app) as client:
        scout_id = _make_scout(client, user_id)
        assert client.post(f"/v1/scouts/{scout_id}/run", headers=_headers(user_id)).status_code == 201
        second = client.post(f"/v1/scouts/{scout_id}/run", headers=_headers(user_id))
        assert second.status_code == 429
        assert "hour" in second.json()["detail"]


def test_run_scout_404_for_other_user(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            scout_id = _make_scout(client, user_id)
            assert (
                client.post(f"/v1/scouts/{scout_id}/run", headers=_headers(other)).status_code
                == 404
            )
    finally:
        asyncio.run(_delete_user(other))


def test_run_archived_scout_is_rejected(user_id):
    with TestClient(app) as client:
        scout_id = _make_scout(client, user_id)
        client.patch(
            f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={"status": "ARCHIVED"}
        )
        response = client.post(f"/v1/scouts/{scout_id}/run", headers=_headers(user_id))
        assert response.status_code == 409


def test_list_and_get_scout_runs_are_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            scout_id = _make_scout(client, user_id)
            run_id = client.post(
                f"/v1/scouts/{scout_id}/run", headers=_headers(user_id)
            ).json()["scoutRun"]["id"]

            listed = client.get(f"/v1/scouts/{scout_id}/runs", headers=_headers(user_id))
            assert listed.status_code == 200
            assert [r["id"] for r in listed.json()["scoutRuns"]] == [run_id]

            single = client.get(f"/v1/scout-runs/{run_id}", headers=_headers(user_id))
            assert single.status_code == 200
            assert single.json()["scoutRun"]["id"] == run_id

            assert (
                client.get(f"/v1/scouts/{scout_id}/runs", headers=_headers(other)).status_code
                == 404
            )
            assert (
                client.get(f"/v1/scout-runs/{run_id}", headers=_headers(other)).status_code == 404
            )
    finally:
        asyncio.run(_delete_user(other))


def test_get_scout_run_404_when_missing(user_id):
    with TestClient(app) as client:
        assert (
            client.get(f"/v1/scout-runs/missing-{uuid.uuid4()}", headers=_headers(user_id)).status_code
            == 404
        )
