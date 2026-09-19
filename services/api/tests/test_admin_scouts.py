"""Admin-wide Scouts table (issue #162, part of the #158 epic): a cross-user,
filterable, paginated list plus admin-scoped run-now/pause/resume/archive
write actions. No Edit or Create endpoint exists anywhere in this file --
a Scout's configuration and creation stay exclusively the candidate's own,
via `v1.py`'s user-scoped endpoints.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    AdminAuditEvent,
    CVVersion,
    Cvconversionstatus,
    Cvfiletype,
    Role,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app
from api.sqs_client import SCOUT_INTAKE_QUEUE_URL, make_sqs_client

HEADERS = {"X-Internal-Api-Secret": "test-secret"}
ADMIN_HEADERS = {**HEADERS, "X-User-Role": "ADMINISTRATOR"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    monkeypatch.setenv("SCOUT_RUN_RATE_LIMIT_SECONDS", "0")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _admin_headers(admin_id: str) -> dict[str, str]:
    return {**ADMIN_HEADERS, "X-User-Id": admin_id}


async def _create_user(role: Role = Role.EXTERNAL) -> str:
    user_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                User(id=user_id, email=f"{user_id}@example.com", role=role, updatedAt=_now())
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


async def _create_cv_version(user_id: str) -> str:
    cv_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                CVVersion(
                    id=cv_id,
                    userId=user_id,
                    label="CV 1",
                    fileKey=f"cv-versions/{user_id}/{cv_id}/cv.pdf",
                    fileName="cv.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=1024,
                    conversionStatus=Cvconversionstatus.CONVERTED,
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return cv_id


async def _create_scout(
    user_id: str,
    cv_version_id: str,
    *,
    status: Scoutstatus = Scoutstatus.ACTIVE,
    last_run_at: datetime | None = None,
    created_at: datetime | None = None,
) -> str:
    scout_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            scout = Scout(
                id=scout_id,
                userId=user_id,
                label="Senior Backend — Remote EU",
                cvVersionId=cv_version_id,
                targetSiteKeys=["FRANCE_TRAVAIL"],
                filters={},
                status=status,
                lastRunAt=last_run_at,
                updatedAt=_now(),
            )
            if created_at is not None:
                scout.createdAt = created_at
            session.add(scout)
            await session.commit()
    finally:
        await engine.dispose()
    return scout_id


async def _get_scout(scout_id: str) -> Scout:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.get(Scout, scout_id)
    finally:
        await engine.dispose()


async def _create_scout_run(scout_id: str, *, created_at: datetime | None = None) -> str:
    run_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            run = ScoutRun(id=run_id, scoutId=scout_id, status=Scoutrunstatus.COMPLETED)
            if created_at is not None:
                run.createdAt = created_at
            session.add(run)
            await session.commit()
    finally:
        await engine.dispose()
    return run_id


async def _audit_events_for_resource(resource_type: str, resource_id: str) -> list[AdminAuditEvent]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            rows = await session.scalars(
                select(AdminAuditEvent).where(
                    AdminAuditEvent.resourceType == resource_type,
                    AdminAuditEvent.resourceId == resource_id,
                )
            )
            return list(rows.all())
    finally:
        await engine.dispose()


def _drain_scout_intake_queue() -> list[str]:
    sqs = make_sqs_client()
    bodies: list[str] = []
    while True:
        received = sqs.receive_message(
            QueueUrl=SCOUT_INTAKE_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=1
        )
        messages = received.get("Messages", [])
        if not messages:
            return bodies
        for message in messages:
            bodies.append(message["Body"])
            sqs.delete_message(
                QueueUrl=SCOUT_INTAKE_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"]
            )


@pytest.fixture
def admin_id():
    uid = asyncio.run(_create_user(role=Role.ADMINISTRATOR))
    yield uid
    asyncio.run(_delete_user(uid))


@pytest.fixture
def target_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


@pytest.fixture
def cv_version_id(target_id):
    return asyncio.run(_create_cv_version(target_id))


# --- GET /v1/admin/scouts ---


def test_list_scouts_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/scouts",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_list_scouts_filters_by_user(admin_id, target_id, cv_version_id):
    scout_id = asyncio.run(_create_scout(target_id, cv_version_id))
    other_id = asyncio.run(_create_user())
    other_cv_id = asyncio.run(_create_cv_version(other_id))
    other_scout_id = asyncio.run(_create_scout(other_id, other_cv_id))
    try:
        with TestClient(app) as client:
            response = client.get(
                "/v1/admin/scouts",
                headers=_admin_headers(admin_id),
                params={"userId": target_id, "pageSize": 100},
            )
        assert response.status_code == 200
        ids = {row["id"] for row in response.json()["scouts"]}
        assert scout_id in ids
        assert other_scout_id not in ids
        row = next(r for r in response.json()["scouts"] if r["id"] == scout_id)
        assert row["userId"] == target_id
        assert row["status"] == "ACTIVE"
    finally:
        asyncio.run(_delete_user(other_id))


def test_list_scouts_filters_by_status_and_last_run_range(admin_id, target_id, cv_version_id):
    paused_id = asyncio.run(
        _create_scout(target_id, cv_version_id, status=Scoutstatus.PAUSED)
    )
    old_run_id = asyncio.run(
        _create_scout(
            target_id,
            cv_version_id,
            last_run_at=_now() - timedelta(days=30),
        )
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/scouts",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "status": "PAUSED", "pageSize": 100},
        )
        assert response.status_code == 200
        ids = {row["id"] for row in response.json()["scouts"]}
        assert paused_id in ids
        assert old_run_id not in ids

        recent_only = client.get(
            "/v1/admin/scouts",
            headers=_admin_headers(admin_id),
            params={
                "userId": target_id,
                "lastRunAtFrom": (_now() - timedelta(days=1)).isoformat(),
                "pageSize": 100,
            },
        )
        assert recent_only.status_code == 200
        recent_ids = {row["id"] for row in recent_only.json()["scouts"]}
        assert old_run_id not in recent_ids


def test_list_scouts_returns_pagination_metadata(admin_id, target_id, cv_version_id):
    asyncio.run(_create_scout(target_id, cv_version_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/scouts",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "page": 1, "pageSize": 20},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["page"] == 1
    assert body["pageSize"] == 20
    assert body["total"] >= 1


# --- POST /v1/admin/scouts/{id}/pause ---


def test_pause_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/pause",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_pause_returns_404_for_unknown_scout(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/pause",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_pause_returns_409_for_archived_scout(admin_id, target_id, cv_version_id):
    scout_id = asyncio.run(
        _create_scout(target_id, cv_version_id, status=Scoutstatus.ARCHIVED)
    )
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/pause",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 409


def test_pause_sets_status_and_records_audit_event_owned_by_candidate(
    admin_id, target_id, cv_version_id
):
    scout_id = asyncio.run(_create_scout(target_id, cv_version_id, status=Scoutstatus.ACTIVE))
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/pause",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    assert response.json() == {"scoutId": scout_id, "status": "PAUSED"}

    updated = asyncio.run(_get_scout(scout_id))
    assert updated.status == Scoutstatus.PAUSED
    assert updated.userId == target_id

    events = asyncio.run(_audit_events_for_resource("Scout", scout_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id
    assert events[0].field is None


# --- POST /v1/admin/scouts/{id}/resume ---


def test_resume_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/resume",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_resume_returns_404_for_unknown_scout(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/resume",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_resume_returns_409_for_archived_scout_no_admin_unarchive(
    admin_id, target_id, cv_version_id
):
    scout_id = asyncio.run(
        _create_scout(target_id, cv_version_id, status=Scoutstatus.ARCHIVED)
    )
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/resume",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 409
    updated = asyncio.run(_get_scout(scout_id))
    assert updated.status == Scoutstatus.ARCHIVED


def test_resume_sets_status_and_records_audit_event_owned_by_candidate(
    admin_id, target_id, cv_version_id
):
    scout_id = asyncio.run(_create_scout(target_id, cv_version_id, status=Scoutstatus.PAUSED))
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/resume",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    assert response.json() == {"scoutId": scout_id, "status": "ACTIVE"}

    updated = asyncio.run(_get_scout(scout_id))
    assert updated.status == Scoutstatus.ACTIVE
    assert updated.userId == target_id

    events = asyncio.run(_audit_events_for_resource("Scout", scout_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id


# --- POST /v1/admin/scouts/{id}/archive ---


def test_archive_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/archive",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_archive_returns_404_for_unknown_scout(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/archive",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_archive_sets_status_and_records_audit_event_owned_by_candidate(
    admin_id, target_id, cv_version_id
):
    scout_id = asyncio.run(_create_scout(target_id, cv_version_id, status=Scoutstatus.ACTIVE))
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/archive",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 200
    assert response.json() == {"scoutId": scout_id, "status": "ARCHIVED"}

    updated = asyncio.run(_get_scout(scout_id))
    assert updated.status == Scoutstatus.ARCHIVED
    assert updated.userId == target_id

    events = asyncio.run(_audit_events_for_resource("Scout", scout_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id


# --- POST /v1/admin/scouts/{id}/run ---


def test_run_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/run",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_run_returns_404_for_unknown_scout(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/scouts/nonexistent/run",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_run_returns_409_for_archived_scout(admin_id, target_id, cv_version_id):
    scout_id = asyncio.run(
        _create_scout(target_id, cv_version_id, status=Scoutstatus.ARCHIVED)
    )
    _drain_scout_intake_queue()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/run",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 409
    assert _drain_scout_intake_queue() == []


def test_run_returns_429_when_rate_limited(admin_id, target_id, cv_version_id, monkeypatch):
    monkeypatch.setenv("SCOUT_RUN_RATE_LIMIT_SECONDS", "3600")
    scout_id = asyncio.run(_create_scout(target_id, cv_version_id))
    asyncio.run(_create_scout_run(scout_id))
    _drain_scout_intake_queue()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/run",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 429
    assert _drain_scout_intake_queue() == []


def test_run_creates_scout_run_enqueues_and_records_audit_event_owned_by_candidate(
    admin_id, target_id, cv_version_id
):
    scout_id = asyncio.run(_create_scout(target_id, cv_version_id))
    _drain_scout_intake_queue()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/scouts/{scout_id}/run",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 201
    body = response.json()
    assert body["scoutId"] == scout_id
    assert body["status"] == "PENDING"
    scout_run_id = body["scoutRunId"]

    bodies = [json.loads(b) for b in _drain_scout_intake_queue()]
    assert bodies == [{"scoutRunId": scout_run_id}]

    events = asyncio.run(_audit_events_for_resource("Scout", scout_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id
