import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import Analysis, Analysisstatus, JobOffer, Joboffersourcesite, User
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
    }
    payload.update(overrides)
    response = client.post("/v1/scouts", headers=_headers(user_id), json=payload)
    assert response.status_code == 201
    return response.json()["scout"]["id"]


async def _seed_completed_analysis(
    *,
    user_id: str,
    cv_version_id: str,
    scout_id: str,
    match_score: int,
    completed_at: datetime | None = None,
) -> str:
    """Directly inserts a COMPLETED Analysis tagged with `scoutId`, as the
    ingestion fan-out does for a Scout run (issue #55) — there is no HTTP
    seam that fabricates a finished analysis, so this test seeds one."""
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
                    completedAt=completed_at or _now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return analysis_id


def test_finds_splits_by_threshold(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv, matchThreshold=70)

        relevant_id = asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_id, match_score=80
            )
        )
        low_fit_id = asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_id, match_score=40
            )
        )
        # Exactly at threshold counts as relevant.
        at_threshold_id = asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_id, match_score=70
            )
        )

        response = client.get(f"/v1/scouts/{scout_id}/finds", headers=_headers(user_id))
        assert response.status_code == 200
        body = response.json()
        assert {a["id"] for a in body["relevantFinds"]} == {relevant_id, at_threshold_id}
        assert {a["id"] for a in body["lowFitFinds"]} == {low_fit_id}
        # Each row is the same shape a manual analysis uses, so the web
        # client can open the identical gap report.
        assert body["relevantFinds"][0]["scoutId"] == scout_id


def test_finds_returns_only_the_ten_most_recent_relevant_analyses(user_id):
    """The panel reads the top of the list, so the endpoint ships the newest
    ten rather than a long-running Scout's whole history. The low-fit list is
    not capped — no client surfaces it, and its cap would be a separate call."""
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv, matchThreshold=70)

        base = _now()
        # Seeded oldest-first, so the twelve newest are the last twelve here.
        seeded = [
            asyncio.run(
                _seed_completed_analysis(
                    user_id=user_id,
                    cv_version_id=cv,
                    scout_id=scout_id,
                    match_score=80,
                    completed_at=base - timedelta(hours=12 - i),
                )
            )
            for i in range(12)
        ]

        response = client.get(f"/v1/scouts/{scout_id}/finds", headers=_headers(user_id))
        assert response.status_code == 200
        returned = [a["id"] for a in response.json()["relevantFinds"]]
        # Newest first, and only ten of the twelve.
        assert returned == list(reversed(seeded[2:]))

        # The true total stays on the Scout itself, which is what the table
        # column and the panel badge read.
        single = client.get(f"/v1/scouts/{scout_id}", headers=_headers(user_id))
        assert single.json()["scout"]["relevantFindsCount"] == 12


def test_finds_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            scout_id = _make_scout(client, user_id, cv)
            response = client.get(f"/v1/scouts/{scout_id}/finds", headers=_headers(other))
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_finds_empty_scout_is_zero_safe(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        response = client.get(f"/v1/scouts/{scout_id}/finds", headers=_headers(user_id))
        assert response.status_code == 200
        assert response.json() == {"relevantFinds": [], "lowFitFinds": []}


def test_scout_list_reports_relevant_finds_count_per_scout(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_a = _make_scout(client, user_id, cv, label="Scout A", matchThreshold=70)
        scout_b = _make_scout(client, user_id, cv, label="Scout B", matchThreshold=70)

        asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_a, match_score=90
            )
        )
        asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_a, match_score=95
            )
        )
        asyncio.run(
            _seed_completed_analysis(
                user_id=user_id, cv_version_id=cv, scout_id=scout_b, match_score=10
            )
        )

        listed = client.get("/v1/scouts", headers=_headers(user_id))
        assert listed.status_code == 200
        counts = {s["id"]: s["relevantFindsCount"] for s in listed.json()["scouts"]}
        assert counts[scout_a] == 2
        assert counts[scout_b] == 0

        single = client.get(f"/v1/scouts/{scout_a}", headers=_headers(user_id))
        assert single.json()["scout"]["relevantFindsCount"] == 2


def test_scout_list_is_zero_safe_with_no_scouts(user_id):
    with TestClient(app) as client:
        response = client.get("/v1/scouts", headers=_headers(user_id))
    assert response.status_code == 200
    assert response.json()["scouts"] == []
