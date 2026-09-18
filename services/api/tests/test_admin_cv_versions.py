"""Admin-wide CV Versions table (issue #163, part of the #158 epic): a
cross-user, filterable, paginated list plus a single admin-scoped write
action (reconvert). No Set default/Import/Replace endpoint exists anywhere
in this file — those stay exclusively the candidate's own to trigger via
`v1.py`'s user-scoped endpoints.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import AdminAuditEvent, CVVersion, Cvconversionstatus, Cvfiletype, Role, User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app
from api.sqs_client import CV_CONVERSION_QUEUE_URL, make_sqs_client

HEADERS = {"X-Internal-Api-Secret": "test-secret"}
ADMIN_HEADERS = {**HEADERS, "X-User-Role": "ADMINISTRATOR"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


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


async def _create_cv_version(
    user_id: str,
    *,
    conversion_status: Cvconversionstatus = Cvconversionstatus.CONVERTED,
    superseded_by_id: str | None = None,
    created_at: datetime | None = None,
) -> str:
    cv_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            cv = CVVersion(
                id=cv_id,
                userId=user_id,
                label="CV 1",
                fileKey=f"cv-versions/{user_id}/{cv_id}/cv.pdf",
                fileName="cv.pdf",
                fileType=Cvfiletype.PDF,
                fileSizeBytes=1024,
                conversionStatus=conversion_status,
                supersededById=superseded_by_id,
                updatedAt=_now(),
            )
            if created_at is not None:
                cv.createdAt = created_at
            session.add(cv)
            await session.commit()
    finally:
        await engine.dispose()
    return cv_id


async def _get_cv_version(cv_id: str) -> CVVersion:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.get(CVVersion, cv_id)
    finally:
        await engine.dispose()


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


def _drain_cv_conversion_queue() -> list[str]:
    sqs = make_sqs_client()
    bodies: list[str] = []
    while True:
        received = sqs.receive_message(
            QueueUrl=CV_CONVERSION_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=1
        )
        messages = received.get("Messages", [])
        if not messages:
            return bodies
        for message in messages:
            bodies.append(message["Body"])
            sqs.delete_message(
                QueueUrl=CV_CONVERSION_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"]
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


# --- GET /v1/admin/cv-versions ---


def test_list_cv_versions_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/cv-versions",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_list_cv_versions_filters_by_user_and_includes_superseded_rows_by_default(
    admin_id, target_id
):
    new_id = asyncio.run(_create_cv_version(target_id))
    old_id = asyncio.run(_create_cv_version(target_id, superseded_by_id=new_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/cv-versions",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "pageSize": 100},
        )
    assert response.status_code == 200
    body = response.json()
    ids = {row["id"] for row in body["cvVersions"]}
    assert old_id in ids
    assert new_id in ids
    row = next(r for r in body["cvVersions"] if r["id"] == old_id)
    assert row["userId"] == target_id
    assert row["conversionStatus"] == "CONVERTED"


def test_list_cv_versions_filters_by_conversion_status_and_date_range(admin_id, target_id):
    pending_id = asyncio.run(
        _create_cv_version(target_id, conversion_status=Cvconversionstatus.PENDING)
    )
    old_id = asyncio.run(
        _create_cv_version(
            target_id,
            conversion_status=Cvconversionstatus.CONVERTED,
            created_at=_now() - timedelta(days=30),
        )
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/cv-versions",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "conversionStatus": "PENDING", "pageSize": 100},
        )
        assert response.status_code == 200
        ids = {row["id"] for row in response.json()["cvVersions"]}
        assert pending_id in ids
        assert old_id not in ids

        recent_only = client.get(
            "/v1/admin/cv-versions",
            headers=_admin_headers(admin_id),
            params={
                "userId": target_id,
                "createdAtFrom": (_now() - timedelta(days=1)).isoformat(),
                "pageSize": 100,
            },
        )
        assert recent_only.status_code == 200
        recent_ids = {row["id"] for row in recent_only.json()["cvVersions"]}
        assert pending_id in recent_ids
        assert old_id not in recent_ids


def test_list_cv_versions_returns_pagination_metadata(admin_id, target_id):
    asyncio.run(_create_cv_version(target_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/cv-versions",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "page": 1, "pageSize": 20},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["page"] == 1
    assert body["pageSize"] == 20
    assert body["total"] >= 1


# --- POST /v1/admin/cv-versions/{id}/reconvert ---


def test_reconvert_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/cv-versions/nonexistent/reconvert",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_reconvert_returns_404_for_unknown_cv_version(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/cv-versions/nonexistent/reconvert",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_reconvert_returns_409_while_converting(admin_id, target_id):
    cv_id = asyncio.run(
        _create_cv_version(target_id, conversion_status=Cvconversionstatus.CONVERTING)
    )
    _drain_cv_conversion_queue()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/cv-versions/{cv_id}/reconvert",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 409
    assert _drain_cv_conversion_queue() == []


def test_reconvert_resets_pending_enqueues_and_records_audit_event_owned_by_candidate(
    admin_id, target_id
):
    cv_id = asyncio.run(
        _create_cv_version(target_id, conversion_status=Cvconversionstatus.FAILED)
    )
    _drain_cv_conversion_queue()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/cv-versions/{cv_id}/reconvert",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 202
    assert response.json() == {"cvVersionId": cv_id, "conversionStatus": "PENDING"}

    updated = asyncio.run(_get_cv_version(cv_id))
    assert updated.conversionStatus == Cvconversionstatus.PENDING
    assert updated.conversionError is None
    # Ownership never moves to the admin (docs/adr/0020).
    assert updated.userId == target_id

    bodies = [json.loads(b) for b in _drain_cv_conversion_queue()]
    assert bodies == [{"cvVersionId": cv_id}]

    events = asyncio.run(_audit_events_for_resource("CVVersion", cv_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id
    assert events[0].field is None
