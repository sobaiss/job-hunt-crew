import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    CVVersion,
    Cvfiletype,
    JobOffer,
    Joboffersourcesite,
    Plan,
    PlanQuotaDefault,
    Quotakind,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select, update

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


async def _free_plan_default(kind: Quotakind) -> int | None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.scalar(
                select(PlanQuotaDefault.limit).where(
                    PlanQuotaDefault.plan == Plan.FREE, PlanQuotaDefault.quotaKind == kind
                )
            )
    finally:
        await engine.dispose()


async def _set_free_plan_default(kind: Quotakind, limit: int | None) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(
                update(PlanQuotaDefault)
                .where(PlanQuotaDefault.plan == Plan.FREE, PlanQuotaDefault.quotaKind == kind)
                .values(limit=limit)
            )
            await session.commit()
    finally:
        await engine.dispose()


def _plan_cap_fixture(kind: Quotakind):
    """Temporarily overrides FREE's `PlanQuotaDefault` for `kind`, matching
    the per-QuotaKind fixtures already established in test_v1_analyses.py,
    test_v1_generated_documents.py, and test_v1_scouts.py.
    """
    original = asyncio.run(_free_plan_default(kind))

    def _apply(limit: int | None) -> None:
        asyncio.run(_set_free_plan_default(kind, limit))

    yield _apply
    asyncio.run(_set_free_plan_default(kind, original))


@pytest.fixture
def active_scouts_cap():
    yield from _plan_cap_fixture(Quotakind.ACTIVE_SCOUTS)


@pytest.fixture
def analyses_daily_cap():
    yield from _plan_cap_fixture(Quotakind.ANALYSES_DAILY)


@pytest.fixture
def analyses_monthly_cap():
    yield from _plan_cap_fixture(Quotakind.ANALYSES_MONTHLY)


@pytest.fixture
def documents_daily_cap():
    yield from _plan_cap_fixture(Quotakind.DOCUMENTS_DAILY)


def _all_caps(
    active_scouts_cap, analyses_daily_cap, analyses_monthly_cap, documents_daily_cap
):
    active_scouts_cap(2)
    analyses_daily_cap(3)
    analyses_monthly_cap(30)
    documents_daily_cap(4)


def test_get_quotas_requires_user_id_header():
    with TestClient(app) as client:
        response = client.get("/v1/quotas", headers=INTERNAL_SECRET_HEADERS)
    assert response.status_code == 401


def test_get_quotas_reports_zero_usage_for_a_fresh_user(
    active_scouts_cap, analyses_daily_cap, analyses_monthly_cap, documents_daily_cap, user_id
):
    _all_caps(active_scouts_cap, analyses_daily_cap, analyses_monthly_cap, documents_daily_cap)
    with TestClient(app) as client:
        response = client.get("/v1/quotas", headers=_headers(user_id))
    assert response.status_code == 200
    assert response.json() == {
        "activeScouts": {"cap": 2, "used": 0, "remaining": 2},
        "analysesDaily": {"cap": 3, "used": 0, "remaining": 3},
        "analysesMonthly": {"cap": 30, "used": 0, "remaining": 30},
        "documentsDaily": {"cap": 4, "used": 0, "remaining": 4},
        "alerts": [],
    }


def test_get_quotas_aggregates_usage_across_all_four_kinds(
    active_scouts_cap,
    analyses_daily_cap,
    analyses_monthly_cap,
    documents_daily_cap,
    user_id,
    job_offer_id,
    cv_version_id,
):
    _all_caps(active_scouts_cap, analyses_daily_cap, analyses_monthly_cap, documents_daily_cap)
    with TestClient(app) as client:
        scout_response = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json={
                "label": "Senior Backend — Remote EU",
                "cvVersionId": cv_version_id,
                "targetSiteKeys": ["FRANCE_TRAVAIL"],
                "filters": {"keywords": "python"},
            },
        )
        assert scout_response.status_code == 201

        analysis_response = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        assert analysis_response.status_code == 202

        body = client.get("/v1/quotas", headers=_headers(user_id)).json()

    assert body["activeScouts"] == {"cap": 2, "used": 1, "remaining": 1}
    assert body["analysesDaily"] == {"cap": 3, "used": 1, "remaining": 2}
    assert body["analysesMonthly"] == {"cap": 30, "used": 1, "remaining": 29}
    assert body["documentsDaily"] == {"cap": 4, "used": 0, "remaining": 4}


def test_get_quotas_unlimited_when_effective_quota_is_none(
    active_scouts_cap, analyses_daily_cap, analyses_monthly_cap, documents_daily_cap, user_id
):
    active_scouts_cap(None)
    analyses_daily_cap(None)
    analyses_monthly_cap(None)
    documents_daily_cap(None)
    with TestClient(app) as client:
        body = client.get("/v1/quotas", headers=_headers(user_id)).json()
    assert body == {
        "activeScouts": {"cap": None, "used": 0, "remaining": None},
        "analysesDaily": {"cap": None, "used": 0, "remaining": None},
        "analysesMonthly": {"cap": None, "used": 0, "remaining": None},
        "documentsDaily": {"cap": None, "used": 0, "remaining": None},
        "alerts": [],
    }


def test_get_quotas_surfaces_unread_alerts_and_analysis_crossing_daily_cap_creates_one(
    active_scouts_cap,
    analyses_daily_cap,
    analyses_monthly_cap,
    documents_daily_cap,
    user_id,
    job_offer_id,
    cv_version_id,
):
    """Issue #142: requesting the one Analysis a daily cap of 1 allows moves
    usage from 0 to 1 — exactly the EXCEEDED crossing — so it both succeeds
    (200/202, unaffected by this ticket) and inserts one QuotaAlert, which
    GET /v1/quotas then surfaces as unread.
    """
    active_scouts_cap(2)
    analyses_daily_cap(1)
    analyses_monthly_cap(30)
    documents_daily_cap(4)
    with TestClient(app) as client:
        analysis_response = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        assert analysis_response.status_code == 202

        body = client.get("/v1/quotas", headers=_headers(user_id)).json()

    assert len(body["alerts"]) == 1
    alert = body["alerts"][0]
    assert alert["quotaKind"] == "ANALYSES_DAILY"
    assert alert["threshold"] == "EXCEEDED"
    assert alert["id"]
    assert alert["createdAt"]


def test_marking_a_quota_alert_read_removes_it_from_the_unread_list(
    active_scouts_cap,
    analyses_daily_cap,
    analyses_monthly_cap,
    documents_daily_cap,
    user_id,
    job_offer_id,
    cv_version_id,
):
    active_scouts_cap(2)
    analyses_daily_cap(1)
    analyses_monthly_cap(30)
    documents_daily_cap(4)
    with TestClient(app) as client:
        client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        alert_id = client.get("/v1/quotas", headers=_headers(user_id)).json()["alerts"][0]["id"]

        read_response = client.post(
            f"/v1/quota-alerts/{alert_id}/read", headers=_headers(user_id)
        )
        assert read_response.status_code == 200

        body = client.get("/v1/quotas", headers=_headers(user_id)).json()

    assert body["alerts"] == []


def test_marking_another_users_quota_alert_read_is_404(
    active_scouts_cap,
    analyses_daily_cap,
    analyses_monthly_cap,
    documents_daily_cap,
    user_id,
    job_offer_id,
    cv_version_id,
):
    active_scouts_cap(2)
    analyses_daily_cap(1)
    analyses_monthly_cap(30)
    documents_daily_cap(4)
    other_user_id = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            client.post(
                "/v1/analyses",
                headers=_headers(user_id),
                json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
            )
            alert_id = client.get("/v1/quotas", headers=_headers(user_id)).json()["alerts"][0][
                "id"
            ]

            response = client.post(
                f"/v1/quota-alerts/{alert_id}/read", headers=_headers(other_user_id)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other_user_id))


def test_get_quotas_scoped_to_caller(
    active_scouts_cap,
    analyses_daily_cap,
    analyses_monthly_cap,
    documents_daily_cap,
    user_id,
    job_offer_id,
    cv_version_id,
):
    _all_caps(active_scouts_cap, analyses_daily_cap, analyses_monthly_cap, documents_daily_cap)
    other_user_id = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            client.post(
                "/v1/analyses",
                headers=_headers(user_id),
                json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
            )
            other_body = client.get("/v1/quotas", headers=_headers(other_user_id)).json()
        assert other_body["analysesDaily"] == {"cap": 3, "used": 0, "remaining": 3}
    finally:
        asyncio.run(_delete_user(other_user_id))
