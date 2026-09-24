"""Admin-wide Analyses table (issue #161, part of the #158 epic): a
cross-user, filterable, paginated list plus two admin-scoped write actions
(retry, generate documents). No Tracking-status transition endpoint exists
anywhere in this file — that stays exclusively the candidate's own to
change via `v1.py`'s user-scoped Application endpoints.
"""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    AdminAuditEvent,
    Analysis,
    Analysisstatus,
    Application,
    Applicationstatus,
    CVVersion,
    Cvfiletype,
    GeneratedDocument,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    Role,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app
from api.sqs_client import (
    ANALYSIS_INTAKE_QUEUE_URL,
    GENERATION_INTAKE_QUEUE_URL,
    make_sqs_client,
)

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
            # GeneratedDocument.cvVersionId is onDelete: Restrict — clear any
            # rows this test created before the CVVersion cascade from User.
            cv_version_ids = (
                await session.scalars(select(CVVersion.id).where(CVVersion.userId == user_id))
            ).all()
            if cv_version_ids:
                await session.execute(
                    delete(GeneratedDocument).where(
                        GeneratedDocument.cvVersionId.in_(cv_version_ids)
                    )
                )
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _create_job_offer(*, title: str = "Software Engineer", company: str = "Acme") -> str:
    job_offer_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                JobOffer(
                    id=job_offer_id,
                    sourceUrl=f"https://example.com/{job_offer_id}",
                    sourceSite=Joboffersourcesite.OTHER,
                    extractionStatus=Jobofferextractionstatus.READY,
                    title=title,
                    company=company,
                    location="Paris",
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return job_offer_id


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
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return cv_id


async def _create_analysis(
    user_id: str,
    job_offer_id: str,
    cv_version_id: str,
    *,
    status: Analysisstatus = Analysisstatus.COMPLETED,
    requested_at: datetime | None = None,
) -> str:
    analysis_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            analysis = Analysis(
                id=analysis_id,
                userId=user_id,
                jobOfferId=job_offer_id,
                cvVersionId=cv_version_id,
                status=status,
            )
            if requested_at is not None:
                analysis.requestedAt = requested_at
            session.add(analysis)
            await session.commit()
    finally:
        await engine.dispose()
    return analysis_id


async def _get_analysis(analysis_id: str) -> Analysis:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.get(Analysis, analysis_id)
    finally:
        await engine.dispose()


async def _generated_documents_for(analysis_id: str) -> list[GeneratedDocument]:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            rows = await session.scalars(
                select(GeneratedDocument).where(GeneratedDocument.analysisId == analysis_id)
            )
            return list(rows.all())
    finally:
        await engine.dispose()


async def _create_application(
    user_id: str,
    analysis_id: str,
    job_offer_id: str,
    cv_version_id: str,
    *,
    status: Applicationstatus = Applicationstatus.DRAFT,
) -> str:
    application_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                Application(
                    id=application_id,
                    userId=user_id,
                    analysisId=analysis_id,
                    jobOfferId=job_offer_id,
                    cvVersionId=cv_version_id,
                    status=status,
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return application_id


async def _application_for(analysis_id: str) -> Application | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(
                select(Application).where(Application.analysisId == analysis_id)
            )
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


def _drain_queue(queue_url: str) -> list[str]:
    sqs = make_sqs_client()
    bodies: list[str] = []
    while True:
        received = sqs.receive_message(
            QueueUrl=queue_url, MaxNumberOfMessages=10, WaitTimeSeconds=1
        )
        messages = received.get("Messages", [])
        if not messages:
            return bodies
        for message in messages:
            bodies.append(message["Body"])
            sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"])


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


# --- GET /v1/admin/analyses ---


def test_list_analyses_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_list_analyses_filters_by_user_and_includes_job_offer_fields(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer(title="Backend Dev", company="Acme"))
    cv_id = asyncio.run(_create_cv_version(target_id))
    analysis_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "pageSize": 100},
        )
    assert response.status_code == 200
    body = response.json()
    row = next(r for r in body["analyses"] if r["id"] == analysis_id)
    assert row["userId"] == target_id
    assert row["jobOfferTitle"] == "Backend Dev"
    assert row["jobOfferCompany"] == "Acme"
    assert row["status"] == "COMPLETED"
    assert row["applicationStatus"] is None


def test_list_analyses_filters_by_requested_at_range(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    recent_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    old_id = asyncio.run(
        _create_analysis(
            target_id, job_offer_id, cv_id, requested_at=_now() - timedelta(days=30)
        )
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={
                "userId": target_id,
                "requestedAtFrom": (_now() - timedelta(days=1)).isoformat(),
                "pageSize": 100,
            },
        )
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["analyses"]}
    assert recent_id in ids
    assert old_id not in ids


def test_list_analyses_filters_by_status_failed(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    failed_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.FAILED)
    )
    completed_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "status": "FAILED", "pageSize": 100},
        )
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["analyses"]}
    assert failed_id in ids
    assert completed_id not in ids


def test_list_analyses_filters_by_status_pending(admin_id, target_id):
    """PENDING is the other raw-pipeline bucket -- where a stuck Analysis sits
    (docs/adr/0032), so an Administrator can single those rows out to requeue."""
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    pending_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.PENDING)
    )
    queued_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.QUEUED)
    )
    completed_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "status": "PENDING", "pageSize": 100},
        )
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["analyses"]}
    assert pending_id in ids
    # The neighbouring non-terminal statuses keep no bucket of their own.
    assert queued_id not in ids
    assert completed_id not in ids


def test_list_analyses_rejects_a_pipeline_status_with_no_bucket(admin_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"status": "RUNNING_CREW"},
        )
    assert response.status_code == 422


def test_list_analyses_filters_by_status_to_apply_with_no_application(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    completed_no_app_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    failed_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.FAILED)
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "status": "TO_APPLY", "pageSize": 100},
        )
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["analyses"]}
    assert completed_no_app_id in ids
    assert failed_id not in ids


def test_list_analyses_filters_by_status_folds_application_status(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    in_progress_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    asyncio.run(
        _create_application(
            target_id, in_progress_id, job_offer_id, cv_id, status=Applicationstatus.APPLIED
        )
    )
    rejected_id = asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    asyncio.run(
        _create_application(
            target_id, rejected_id, job_offer_id, cv_id, status=Applicationstatus.REJECTED
        )
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "status": "IN_PROGRESS", "pageSize": 100},
        )
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["analyses"]}
    assert in_progress_id in ids
    assert rejected_id not in ids


def test_list_analyses_rejects_invalid_status(admin_id):
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"status": "NOT_A_STATUS"},
        )
    assert response.status_code == 422


def test_list_analyses_returns_pagination_metadata(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    asyncio.run(_create_analysis(target_id, job_offer_id, cv_id))
    with TestClient(app) as client:
        response = client.get(
            "/v1/admin/analyses",
            headers=_admin_headers(admin_id),
            params={"userId": target_id, "page": 1, "pageSize": 20},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["page"] == 1
    assert body["pageSize"] == 20
    assert body["total"] >= 1


# --- POST /v1/admin/analyses/{id}/retry ---


def test_retry_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/analyses/nonexistent/retry",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_retry_returns_404_for_unknown_analysis(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/analyses/nonexistent/retry",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_retry_creates_new_analysis_owned_by_candidate_and_records_audit_event(
    admin_id, target_id
):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    analysis_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.FAILED)
    )
    _drain_queue(ANALYSIS_INTAKE_QUEUE_URL)
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/analyses/{analysis_id}/retry",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 202
    body = response.json()
    new_analysis_id = body["analysisId"]
    assert new_analysis_id != analysis_id
    assert body["status"] == "PENDING"

    new_analysis = asyncio.run(_get_analysis(new_analysis_id))
    assert new_analysis.userId == target_id
    assert new_analysis.jobOfferId == job_offer_id
    assert new_analysis.cvVersionId == cv_id
    assert new_analysis.status == Analysisstatus.PENDING

    bodies = [json.loads(b) for b in _drain_queue(ANALYSIS_INTAKE_QUEUE_URL)]
    assert bodies == [{"analysisId": new_analysis_id}]

    events = asyncio.run(_audit_events_for_resource("Analysis", new_analysis_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id


# --- POST /v1/admin/analyses/{id}/generated-documents ---


def test_generate_documents_requires_admin(target_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/analyses/nonexistent/generated-documents",
            headers={**HEADERS, "X-User-Id": target_id, "X-User-Role": "EXTERNAL"},
        )
    assert response.status_code == 403


def test_generate_documents_returns_404_for_unknown_analysis(admin_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/admin/analyses/nonexistent/generated-documents",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 404


def test_generate_documents_returns_400_when_not_completed(admin_id, target_id):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    analysis_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.RUNNING_CREW)
    )
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/analyses/{analysis_id}/generated-documents",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 400


def test_generate_documents_creates_rows_owned_by_candidate_and_records_audit_event(
    admin_id, target_id
):
    job_offer_id = asyncio.run(_create_job_offer())
    cv_id = asyncio.run(_create_cv_version(target_id))
    analysis_id = asyncio.run(
        _create_analysis(target_id, job_offer_id, cv_id, status=Analysisstatus.COMPLETED)
    )
    _drain_queue(GENERATION_INTAKE_QUEUE_URL)
    with TestClient(app) as client:
        response = client.post(
            f"/v1/admin/analyses/{analysis_id}/generated-documents",
            headers=_admin_headers(admin_id),
        )
    assert response.status_code == 202
    body = response.json()
    assert len(body["generatedDocuments"]) == 2
    assert {d["type"] for d in body["generatedDocuments"]} == {"COVER_LETTER", "TAILORED_CV"}

    documents = asyncio.run(_generated_documents_for(analysis_id))
    assert len(documents) == 2

    application = asyncio.run(_application_for(analysis_id))
    assert application is not None
    assert application.userId == target_id
    assert application.status == Applicationstatus.DRAFT

    bodies = [json.loads(b) for b in _drain_queue(GENERATION_INTAKE_QUEUE_URL)]
    assert len(bodies) == 2

    events = asyncio.run(_audit_events_for_resource("Analysis", analysis_id))
    assert len(events) == 1
    assert events[0].actorUserId == admin_id
    assert events[0].targetUserId == target_id
