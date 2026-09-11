import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    Application,
    CVVersion,
    JobOffer,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

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
            # Application.cvVersionId is onDelete: Restrict — clear any rows
            # this test created before the CVVersion cascade from User.
            cv_version_ids = (
                await session.scalars(select(CVVersion.id).where(CVVersion.userId == user_id))
            ).all()
            if cv_version_ids:
                await session.execute(
                    delete(Application).where(Application.cvVersionId.in_(cv_version_ids))
                )
            await session.execute(delete(User).where(User.id == user_id))
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


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


async def _seed_analysis(
    *, user_id: str, cv_version_id: str, status: Analysisstatus, scout_id: str | None = None
) -> str:
    job_offer_id = str(uuid.uuid4())
    analysis_id = str(uuid.uuid4())
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
            session.add(
                Analysis(
                    id=analysis_id,
                    userId=user_id,
                    jobOfferId=job_offer_id,
                    cvVersionId=cv_version_id,
                    scoutId=scout_id,
                    status=status,
                    resultJSON={"matched_skills": [], "missing_skills": []}
                    if status == Analysisstatus.COMPLETED
                    else None,
                    matchScore=80 if status == Analysisstatus.COMPLETED else None,
                    completedAt=_now() if status == Analysisstatus.COMPLETED else None,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return analysis_id


def test_create_application_creates_a_draft_row(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )

        response = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        )
        assert response.status_code == 201
        body = response.json()["application"]
        assert body["analysisId"] == analysis_id
        assert body["status"] == "DRAFT"
        assert body["appliedAt"] is None
        assert body["jobOffer"]["id"]
        assert body["cvVersion"]["label"] == "Base CV"


def test_create_application_is_idempotent_per_analysis(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )

        first = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        )
        second = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        )
        assert first.status_code == 201
        assert second.status_code == 200
        assert first.json()["application"]["id"] == second.json()["application"]["id"]


def test_create_application_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            response = client.post(
                "/v1/applications", headers=_headers(other), json={"analysisId": analysis_id}
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_list_applications_filters_by_status_and_scout(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_draft = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        analysis_scouted = asyncio.run(
            _seed_analysis(
                user_id=user_id,
                cv_version_id=cv,
                status=Analysisstatus.COMPLETED,
                scout_id="scout-1",
            )
        )
        app_draft = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_draft}
        ).json()["application"]
        app_scouted = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_scouted}
        ).json()["application"]
        client.post(
            f"/v1/applications/{app_scouted['id']}/status-events",
            headers=_headers(user_id),
            json={"status": "APPLIED", "effectiveDate": _now().isoformat()},
        )

        all_response = client.get("/v1/applications", headers=_headers(user_id))
        assert all_response.status_code == 200
        rows = all_response.json()["applications"]
        ids = {a["id"] for a in rows}
        assert ids == {app_draft["id"], app_scouted["id"]}
        assert all(row["jobOffer"]["id"] and row["cvVersion"]["label"] for row in rows)

        by_status = client.get(
            "/v1/applications", headers=_headers(user_id), params={"status": "APPLIED"}
        )
        assert [a["id"] for a in by_status.json()["applications"]] == [app_scouted["id"]]

        by_scout = client.get(
            "/v1/applications", headers=_headers(user_id), params={"scoutId": "scout-1"}
        )
        assert [a["id"] for a in by_scout.json()["applications"]] == [app_scouted["id"]]


def test_list_applications_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            client.post(
                "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
            )
            response = client.get("/v1/applications", headers=_headers(other))
        assert response.status_code == 200
        assert response.json()["applications"] == []
    finally:
        asyncio.run(_delete_user(other))


def test_get_application_returns_job_offer_and_status_events(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        application_id = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        ).json()["application"]["id"]

        response = client.get(f"/v1/applications/{application_id}", headers=_headers(user_id))
        assert response.status_code == 200
        body = response.json()["application"]
        assert body["id"] == application_id
        assert body["jobOffer"]["id"]
        assert body["statusEvents"] == []


def test_get_application_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            application_id = client.post(
                "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
            ).json()["application"]["id"]

            response = client.get(f"/v1/applications/{application_id}", headers=_headers(other))
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_get_application_missing_id_is_404(user_id):
    with TestClient(app) as client:
        response = client.get(f"/v1/applications/{uuid.uuid4()}", headers=_headers(user_id))
        assert response.status_code == 404


def test_add_status_event_updates_derived_status_and_applied_at(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        application_id = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        ).json()["application"]["id"]

        response = client.post(
            f"/v1/applications/{application_id}/status-events",
            headers=_headers(user_id),
            json={"status": "APPLIED", "note": "Applied via site", "effectiveDate": _now().isoformat()},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["application"]["status"] == "APPLIED"
        assert body["application"]["appliedAt"] is not None
        assert body["statusEvent"]["status"] == "APPLIED"
        assert body["statusEvent"]["note"] == "Applied via site"

        detail = client.get(f"/v1/applications/{application_id}", headers=_headers(user_id)).json()
        assert len(detail["application"]["statusEvents"]) == 1


def test_add_status_event_supports_undo_by_appending_a_new_event(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        application_id = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        ).json()["application"]["id"]

        client.post(
            f"/v1/applications/{application_id}/status-events",
            headers=_headers(user_id),
            json={"status": "APPLIED", "effectiveDate": _now().isoformat()},
        )
        undo = client.post(
            f"/v1/applications/{application_id}/status-events",
            headers=_headers(user_id),
            json={"status": "DRAFT", "effectiveDate": _now().isoformat()},
        )
        assert undo.status_code == 201
        assert undo.json()["application"]["status"] == "DRAFT"

        detail = client.get(f"/v1/applications/{application_id}", headers=_headers(user_id)).json()
        assert len(detail["application"]["statusEvents"]) == 2


def test_add_status_event_rejects_invalid_status(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        application_id = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        ).json()["application"]["id"]

        response = client.post(
            f"/v1/applications/{application_id}/status-events",
            headers=_headers(user_id),
            json={"status": "NOT_A_STATUS"},
        )
        assert response.status_code == 400


def test_add_status_event_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            application_id = client.post(
                "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
            ).json()["application"]["id"]

            response = client.post(
                f"/v1/applications/{application_id}/status-events",
                headers=_headers(other),
                json={"status": "APPLIED"},
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_delete_cv_version_referenced_by_application_is_rejected(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        client.post("/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id})

        response = client.delete(f"/v1/cv-versions/{cv}", headers=_headers(user_id))
        assert response.status_code == 409
