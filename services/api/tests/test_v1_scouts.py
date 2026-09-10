import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import User
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete

from api.main import app

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


def _make_cv_version(client: TestClient, user_id: str, label: str = "Base CV") -> str:
    response = client.post(
        "/v1/cv-versions",
        headers=_headers(user_id),
        json={
            "label": label,
            "fileName": "cv.pdf",
            "contentType": "application/pdf",
            "fileSizeBytes": 1024,
        },
    )
    assert response.status_code == 201
    return response.json()["cvVersionId"]


def _scout_payload(cv_version_id: str, **overrides):
    payload = {
        "label": "Senior Backend — Remote EU",
        "cvVersionId": cv_version_id,
        "targetSiteKeys": ["FRANCE_TRAVAIL"],
        "filters": {"keywords": "python", "postedWithin": "7d"},
    }
    payload.update(overrides)
    return payload


def test_create_scout_requires_user_id_header():
    with TestClient(app) as client:
        response = client.post(
            "/v1/scouts",
            headers=INTERNAL_SECRET_HEADERS,
            json={"label": "x", "cvVersionId": "x", "targetSiteKeys": ["FRANCE_TRAVAIL"]},
        )
    assert response.status_code == 401


def test_create_scout_requires_label(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        response = client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="   ")
        )
    assert response.status_code == 400
    assert "label" in response.json()["detail"]


def test_create_scout_rejects_unknown_cv_version(user_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json=_scout_payload("does-not-exist"),
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown cvVersionId"


def test_create_scout_rejects_other_users_cv_version(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            other_cv = _make_cv_version(client, other)
            response = client.post(
                "/v1/scouts", headers=_headers(user_id), json=_scout_payload(other_cv)
            )
        assert response.status_code == 400
        assert response.json()["detail"] == "Unknown cvVersionId"
    finally:
        asyncio.run(_delete_user(other))


def test_create_scout_requires_at_least_one_site(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        response = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json=_scout_payload(cv, targetSiteKeys=[]),
        )
    assert response.status_code == 400
    assert "targetSiteKeys" in response.json()["detail"]


def test_create_scout_rejects_unknown_site_key(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        response = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json=_scout_payload(cv, targetSiteKeys=["MONSTER"]),
        )
    assert response.status_code == 400


def test_create_scout_rejects_out_of_range_threshold(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        response = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json=_scout_payload(cv, matchThreshold=150),
        )
    assert response.status_code == 400
    assert "matchThreshold" in response.json()["detail"]


def test_create_scout_defaults_threshold_and_normalizes(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        response = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json={
                "label": "  My Scout  ",
                "cvVersionId": cv,
                "targetSiteKeys": ["FRANCE_TRAVAIL", "FRANCE_TRAVAIL", "LINKEDIN"],
                "filters": {"keywords": "  go  "},
            },
        )
        assert response.status_code == 201
        scout = response.json()["scout"]
        assert scout["label"] == "My Scout"
        assert scout["matchThreshold"] == 70
        assert scout["status"] == "ACTIVE"
        assert scout["targetSiteKeys"] == ["FRANCE_TRAVAIL", "LINKEDIN"]
        assert scout["filters"] == {
            "keywords": "go",
            "location": None,
            "postedWithin": None,
            "contractType": None,
            "remote": None,
            "experienceLevel": None,
        }
        assert scout["lastRunAt"] is None


def test_create_and_list_scopes_to_user(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            first = client.post(
                "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="First")
            ).json()["scout"]
            second = client.post(
                "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="Second")
            ).json()["scout"]

            listed = client.get("/v1/scouts", headers=_headers(user_id)).json()["scouts"]
            assert [s["id"] for s in listed] == [second["id"], first["id"]]

            other_list = client.get("/v1/scouts", headers=_headers(other)).json()
            assert other_list["scouts"] == []
    finally:
        asyncio.run(_delete_user(other))


def test_get_scout_404_for_other_user(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            scout_id = client.post(
                "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv)
            ).json()["scout"]["id"]

            assert client.get(f"/v1/scouts/{scout_id}", headers=_headers(user_id)).status_code == 200
            assert (
                client.get(f"/v1/scouts/{scout_id}", headers=_headers(other)).status_code == 404
            )
    finally:
        asyncio.run(_delete_user(other))


def test_max_scouts_per_user_enforced(user_id, monkeypatch):
    monkeypatch.setenv("MAX_SCOUTS_PER_USER", "2")
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        for i in range(2):
            assert (
                client.post(
                    "/v1/scouts",
                    headers=_headers(user_id),
                    json=_scout_payload(cv, label=f"Scout {i}"),
                ).status_code
                == 201
            )
        third = client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="Scout 3")
        )
        assert third.status_code == 400
        assert "at most 2 active Scouts" in third.json()["detail"]


def test_patch_relabel_and_reconfigure(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        cv2 = _make_cv_version(client, user_id, label="Other CV")
        scout_id = client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv)
        ).json()["scout"]["id"]

        response = client.patch(
            f"/v1/scouts/{scout_id}",
            headers=_headers(user_id),
            json={
                "label": "Renamed",
                "cvVersionId": cv2,
                "targetSiteKeys": ["LINKEDIN", "WTTJ"],
                "matchThreshold": 85,
                "filters": {"location": "Paris"},
            },
        )
        assert response.status_code == 200
        scout = response.json()["scout"]
        assert scout["label"] == "Renamed"
        assert scout["cvVersionId"] == cv2
        assert scout["targetSiteKeys"] == ["LINKEDIN", "WTTJ"]
        assert scout["matchThreshold"] == 85
        assert scout["filters"]["location"] == "Paris"


def test_patch_pause_resume_archive(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv)
        ).json()["scout"]["id"]

        def patch_status(status):
            return client.patch(
                f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={"status": status}
            )

        assert patch_status("PAUSED").json()["scout"]["status"] == "PAUSED"
        assert patch_status("ACTIVE").json()["scout"]["status"] == "ACTIVE"
        assert patch_status("ARCHIVED").json()["scout"]["status"] == "ARCHIVED"

        # Archived is read-only.
        blocked = client.patch(
            f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={"label": "nope"}
        )
        assert blocked.status_code == 409


def test_patch_rejects_empty_body_and_bad_status(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv)
        ).json()["scout"]["id"]

        assert (
            client.patch(f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={}).status_code
            == 400
        )
        assert (
            client.patch(
                f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={"status": "SLEEPING"}
            ).status_code
            == 400
        )


def test_patch_resume_blocked_when_at_active_cap(user_id, monkeypatch):
    monkeypatch.setenv("MAX_SCOUTS_PER_USER", "1")
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        first = client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="First")
        ).json()["scout"]["id"]
        # Pause the first so a second ACTIVE Scout can be created.
        client.patch(f"/v1/scouts/{first}", headers=_headers(user_id), json={"status": "PAUSED"})
        client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="Second")
        )
        # Resuming the first would make 2 active with a cap of 1.
        resume = client.patch(
            f"/v1/scouts/{first}", headers=_headers(user_id), json={"status": "ACTIVE"}
        )
        assert resume.status_code == 400


def test_patch_404_for_other_user(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            scout_id = client.post(
                "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv)
            ).json()["scout"]["id"]
            response = client.patch(
                f"/v1/scouts/{scout_id}", headers=_headers(other), json={"label": "hijack"}
            )
            assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_delete_cv_version_blocked_while_scout_references_it(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        client.post(
            "/v1/scouts", headers=_headers(user_id), json=_scout_payload(cv, label="My Scout")
        )

        response = client.delete(f"/v1/cv-versions/{cv}", headers=_headers(user_id))
        assert response.status_code == 409
        assert '"My Scout"' in response.json()["detail"]

        still_there = client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        assert any(row["id"] == cv for row in still_there)


def test_delete_cv_version_succeeds_when_unreferenced(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        response = client.delete(f"/v1/cv-versions/{cv}", headers=_headers(user_id))
        assert response.status_code == 204

        remaining = client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        assert all(row["id"] != cv for row in remaining)
