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
    # CVVersion.userId has ondelete=CASCADE, so this also removes any rows
    # created for the user during the test.
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


def test_create_cv_version_requires_user_id_header():
    with TestClient(app) as client:
        response = client.post(
            "/v1/cv-versions",
            headers=INTERNAL_SECRET_HEADERS,
            json={
                "label": "Software Engineer",
                "fileName": "cv.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        )
    assert response.status_code == 401


def test_create_cv_version_rejects_unsupported_content_type(user_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Software Engineer",
                "fileName": "cv.rtf",
                "contentType": "application/rtf",
                "fileSizeBytes": 1024,
            },
        )
    assert response.status_code == 400
    assert "Unsupported file type" in response.json()["detail"]


def test_create_cv_version_accepts_markdown_and_plain_text(user_id):
    with TestClient(app) as client:
        md = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Markdown CV",
                "fileName": "cv.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        )
        assert md.status_code == 201

        txt = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Plain text CV",
                "fileName": "cv.txt",
                "contentType": "text/plain",
                "fileSizeBytes": 1024,
            },
        )
        assert txt.status_code == 201

        # A generic text/plain for a .md file is stored as MD (filename tie-break).
        md_tiebreak = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Markdown CV via text/plain",
                "fileName": "resume.md",
                "contentType": "text/plain",
                "fileSizeBytes": 1024,
            },
        )
        assert md_tiebreak.status_code == 201

        by_id = {
            row["id"]: row
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert by_id[md.json()["cvVersionId"]]["fileType"] == "MD"
        assert by_id[txt.json()["cvVersionId"]]["fileType"] == "TXT"
        assert by_id[md_tiebreak.json()["cvVersionId"]]["fileType"] == "MD"


def test_create_cv_version_rejects_oversize_file(user_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Software Engineer",
                "fileName": "cv.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 11 * 1024 * 1024,
            },
        )
    assert response.status_code == 400
    assert "File too large" in response.json()["detail"]


def test_create_cv_version_success_and_list(user_id):
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Software Engineer — Fintech",
                "fileName": "cv.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        )
        assert create_response.status_code == 201
        body = create_response.json()
        assert body["fileKey"] == f"cvs/{user_id}/{body['cvVersionId']}/cv.pdf"
        assert body["uploadUrl"]

        list_response = client.get("/v1/cv-versions", headers=_headers(user_id))
        assert list_response.status_code == 200
        cv_versions = list_response.json()["cvVersions"]
        assert len(cv_versions) == 1
        assert cv_versions[0]["id"] == body["cvVersionId"]
        assert cv_versions[0]["fileType"] == "PDF"
        assert cv_versions[0]["isDefault"] is False
        assert cv_versions[0]["parseStatus"] == "PENDING"
        assert cv_versions[0]["conversionStatus"] == "PENDING"


def test_set_default_unsets_exactly_one_prior_default(user_id):
    with TestClient(app) as client:
        cv1 = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        cv2 = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 2",
                "fileName": "cv2.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        set_cv1_default = client.patch(
            f"/v1/cv-versions/{cv1}", headers=_headers(user_id), json={"isDefault": True}
        )
        assert set_cv1_default.status_code == 200
        assert set_cv1_default.json()["cvVersion"]["isDefault"] is True

        set_cv2_default = client.patch(
            f"/v1/cv-versions/{cv2}", headers=_headers(user_id), json={"isDefault": True}
        )
        assert set_cv2_default.status_code == 200
        assert set_cv2_default.json()["cvVersion"]["isDefault"] is True

        listed = client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        defaults = [row for row in listed if row["isDefault"]]
        assert len(defaults) == 1
        assert defaults[0]["id"] == cv2


def test_patch_rejects_empty_update_and_empty_label(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        nothing_to_update = client.patch(f"/v1/cv-versions/{cv_id}", headers=_headers(user_id), json={})
        assert nothing_to_update.status_code == 400
        assert nothing_to_update.json()["detail"] == "Nothing to update"

        empty_label = client.patch(
            f"/v1/cv-versions/{cv_id}", headers=_headers(user_id), json={"label": "   "}
        )
        assert empty_label.status_code == 400
        assert empty_label.json()["detail"] == "label must not be empty"


def test_patch_returns_404_for_other_users_cv(user_id):
    other_user_id = None
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        other_user_id = asyncio.run(_create_user())
        try:
            response = client.patch(
                f"/v1/cv-versions/{cv_id}", headers=_headers(other_user_id), json={"label": "hijack"}
            )
            assert response.status_code == 404

            other_list = client.get("/v1/cv-versions", headers=_headers(other_user_id)).json()
            assert other_list["cvVersions"] == []
        finally:
            asyncio.run(_delete_user(other_user_id))
