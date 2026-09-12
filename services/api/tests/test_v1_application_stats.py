import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    Application,
    CVVersion,
    GeneratedDocument,
    Generateddocumentstatus,
    Generateddocumenttype,
    JobOffer,
    Joboffersourcesite,
    ScoutRun,
    StatusEvent,
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
            cv_version_ids = (
                await session.scalars(select(CVVersion.id).where(CVVersion.userId == user_id))
            ).all()
            if cv_version_ids:
                await session.execute(
                    delete(Application).where(Application.cvVersionId.in_(cv_version_ids))
                )
                await session.execute(
                    delete(GeneratedDocument).where(GeneratedDocument.cvVersionId.in_(cv_version_ids))
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


def _make_scout(client: TestClient, user_id: str, cv_version_id: str, **overrides) -> str:
    payload = {
        "label": "Senior Backend — Remote EU",
        "cvVersionId": cv_version_id,
        "targetSiteKeys": ["FRANCE_TRAVAIL"],
        "filters": {"keywords": "python"},
        "matchThreshold": 70,
    }
    payload.update(overrides)
    response = client.post("/v1/scouts", headers=_headers(user_id), json=payload)
    assert response.status_code == 201
    return response.json()["scout"]["id"]


async def _seed_scout_run(*, scout_id: str, offers_discovered: int, created_at: datetime) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                ScoutRun(
                    id=str(uuid.uuid4()),
                    scoutId=scout_id,
                    offersDiscovered=offers_discovered,
                    createdAt=created_at,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


async def _seed_completed_analysis(
    *, user_id: str, cv_version_id: str, scout_id: str, match_score: int, completed_at: datetime
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
                    status=Analysisstatus.COMPLETED,
                    matchScore=match_score,
                    completedAt=completed_at,
                    resultJSON={"matched_skills": [], "missing_skills": []},
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return analysis_id


async def _seed_generated_document(*, analysis_id: str, created_at: datetime) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            analysis = await session.get(Analysis, analysis_id)
            session.add(
                GeneratedDocument(
                    id=str(uuid.uuid4()),
                    type=Generateddocumenttype.COVER_LETTER,
                    analysisId=analysis.id,
                    jobOfferId=analysis.jobOfferId,
                    cvVersionId=analysis.cvVersionId,
                    status=Generateddocumentstatus.READY,
                    markdownContent="# Cover letter",
                    createdAt=created_at,
                    updatedAt=created_at,
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


async def _add_status_event(
    *, application_id: str, status, effective_date: datetime, created_at: datetime
) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                StatusEvent(
                    id=str(uuid.uuid4()),
                    applicationId=application_id,
                    status=status,
                    effectiveDate=effective_date,
                    createdAt=created_at,
                )
            )
            application = await session.get(Application, application_id)
            application.status = status
            if application.appliedAt is None:
                application.appliedAt = effective_date
            await session.commit()
    finally:
        await engine.dispose()


def test_application_stats_are_zero_safe_with_no_data(user_id):
    with TestClient(app) as client:
        response = client.get("/v1/applications/stats", headers=_headers(user_id))
        assert response.status_code == 200
        body = response.json()
        for window in (body["allTime"], body["last30Days"]):
            assert window["offersDiscovered"] == 0
            assert window["relevantFinds"] == 0
            assert window["documentsGenerated"] == 0
            assert window["applicationsSubmitted"] == 0
            assert window["responseRate"] == 0.0
            assert window["medianDaysToFirstResponse"] is None


def test_application_stats_computes_metrics_from_seeded_data(user_id):
    with TestClient(app) as client:
        from py_db.models import Applicationstatus

        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        now = _now()

        asyncio.run(_seed_scout_run(scout_id=scout_id, offers_discovered=5, created_at=now))

        relevant_id = asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_id, match_score=85, completed_at=now
            )
        )
        asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_id, match_score=40, completed_at=now
            )
        )
        asyncio.run(_seed_generated_document(analysis_id=relevant_id, created_at=now))

        application_id = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": relevant_id}
        ).json()["application"]["id"]

        applied_at = now - timedelta(days=5)
        asyncio.run(
            _add_status_event(
                application_id=application_id,
                status=Applicationstatus.APPLIED,
                effective_date=applied_at,
                created_at=applied_at,
            )
        )
        interview_at = applied_at + timedelta(days=3)
        asyncio.run(
            _add_status_event(
                application_id=application_id,
                status=Applicationstatus.INTERVIEWING,
                effective_date=interview_at,
                created_at=interview_at,
            )
        )

        response = client.get("/v1/applications/stats", headers=_headers(user_id))
        assert response.status_code == 200
        window = response.json()["allTime"]
        assert window["offersDiscovered"] == 5
        assert window["relevantFinds"] == 1
        assert window["documentsGenerated"] == 1
        assert window["applicationsSubmitted"] == 1
        assert window["responseRate"] == 100.0
        assert window["interviewRate"] == 100.0
        assert window["offerRate"] == 0.0
        assert window["medianDaysToFirstResponse"] == 3.0


def test_application_stats_last_30_days_excludes_older_data(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        old = _now() - timedelta(days=60)

        asyncio.run(_seed_scout_run(scout_id=scout_id, offers_discovered=7, created_at=old))
        asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_id, match_score=90, completed_at=old
            )
        )

        response = client.get("/v1/applications/stats", headers=_headers(user_id))
        assert response.status_code == 200
        body = response.json()
        assert body["allTime"]["offersDiscovered"] == 7
        assert body["allTime"]["relevantFinds"] == 1
        assert body["last30Days"]["offersDiscovered"] == 0
        assert body["last30Days"]["relevantFinds"] == 0


def test_scout_stats_scoped_to_one_scout(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_a = _make_scout(client, user_id, cv, label="Scout A")
        scout_b = _make_scout(client, user_id, cv, label="Scout B")
        now = _now()

        asyncio.run(_seed_scout_run(scout_id=scout_a, offers_discovered=3, created_at=now))
        asyncio.run(_seed_scout_run(scout_id=scout_b, offers_discovered=9, created_at=now))

        response = client.get(f"/v1/scouts/{scout_a}/stats", headers=_headers(user_id))
        assert response.status_code == 200
        assert response.json()["allTime"]["offersDiscovered"] == 3

        response_b = client.get(f"/v1/scouts/{scout_b}/stats", headers=_headers(user_id))
        assert response_b.json()["allTime"]["offersDiscovered"] == 9


def test_scout_stats_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            scout_id = _make_scout(client, user_id, cv)
            response = client.get(f"/v1/scouts/{scout_id}/stats", headers=_headers(other))
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_scout_patterns_ranks_required_missing_skills_by_frequency(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        now = _now()

        async def _seed_with_result(result_json: dict) -> None:
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
                    session.add(
                        Analysis(
                            id=str(uuid.uuid4()),
                            userId=user_id,
                            jobOfferId=job_offer_id,
                            cvVersionId=cv,
                            scoutId=scout_id,
                            status=Analysisstatus.COMPLETED,
                            matchScore=50,
                            completedAt=now,
                            resultJSON=result_json,
                        )
                    )
                    await session.commit()
            finally:
                await engine.dispose()

        asyncio.run(
            _seed_with_result(
                {
                    "missing_skills": [
                        {"skill": "Kubernetes", "importance": "required"},
                        {"skill": "Terraform", "importance": "nice_to_have"},
                    ]
                }
            )
        )
        asyncio.run(
            _seed_with_result(
                {"missing_skills": [{"skill": "kubernetes", "importance": "required"}]}
            )
        )
        asyncio.run(
            _seed_with_result(
                {"missing_skills": [{"skill": "GraphQL", "importance": "required"}]}
            )
        )

        response = client.get(f"/v1/scouts/{scout_id}/patterns", headers=_headers(user_id))
        assert response.status_code == 200
        patterns = response.json()["patterns"]
        assert patterns[0] == {"skill": "Kubernetes", "count": 2}
        assert {"skill": "GraphQL", "count": 1} in patterns
        assert not any(p["skill"].lower() == "terraform" for p in patterns)


def test_scout_patterns_ranks_weaknesses_by_exact_text_frequency(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        now = _now()

        async def _seed_with_result(result_json: dict) -> None:
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
                    session.add(
                        Analysis(
                            id=str(uuid.uuid4()),
                            userId=user_id,
                            jobOfferId=job_offer_id,
                            cvVersionId=cv,
                            scoutId=scout_id,
                            status=Analysisstatus.COMPLETED,
                            matchScore=50,
                            completedAt=now,
                            resultJSON=result_json,
                        )
                    )
                    await session.commit()
            finally:
                await engine.dispose()

        asyncio.run(
            _seed_with_result({"weaknesses": ["Limited cloud experience", "No team leadership"]})
        )
        asyncio.run(_seed_with_result({"weaknesses": ["limited cloud experience"]}))
        asyncio.run(_seed_with_result({"weaknesses": ["Weak in system design"]}))

        response = client.get(f"/v1/scouts/{scout_id}/patterns", headers=_headers(user_id))
        assert response.status_code == 200
        weaknesses = response.json()["weaknesses"]
        assert weaknesses[0] == {"weakness": "Limited cloud experience", "count": 2}
        assert {"weakness": "No team leadership", "count": 1} in weaknesses
        assert {"weakness": "Weak in system design", "count": 1} in weaknesses


def test_scout_patterns_empty_with_no_finds(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        response = client.get(f"/v1/scouts/{scout_id}/patterns", headers=_headers(user_id))
        assert response.status_code == 200
        assert response.json()["patterns"] == []
        assert response.json()["weaknesses"] == []


def test_scout_patterns_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            scout_id = _make_scout(client, user_id, cv)
            response = client.get(f"/v1/scouts/{scout_id}/patterns", headers=_headers(other))
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))
