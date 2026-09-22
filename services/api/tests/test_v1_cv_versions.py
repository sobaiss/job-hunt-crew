import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    Application,
    CVVersion,
    Cvconversionstatus,
    GeneratedDocument,
    IngestionJob,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from botocore.exceptions import ClientError

from api.main import app
from api.s3_client import S3_BUCKET, make_s3_client
from api.sqs_client import CV_CONVERSION_QUEUE_URL, make_sqs_client

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
    # created for the user during the test. GeneratedDocument.cvVersionId is
    # onDelete: Restrict, though, so any such row must be cleared first or
    # the CVVersion cascade from User would raise an IntegrityError.
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
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


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _seed_analysis(*, user_id: str, cv_version_id: str, status: Analysisstatus) -> str:
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


async def _delete_applications_for_analysis(analysis_id: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            await session.execute(delete(Application).where(Application.analysisId == analysis_id))
            await session.commit()
    finally:
        await engine.dispose()


async def _seed_ingestion_job(*, user_id: str, cv_version_id: str) -> str:
    """Seeds an IngestionJob directly (mirrors
    test_v1_analyses.py's `_link_analysis_to_new_ingestion_job`) — there's no
    endpoint that creates one referencing a CV without running the full
    ingestion pipeline, so this bypasses it to exercise the delete check in
    isolation."""
    ingestion_job_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                IngestionJob(
                    id=ingestion_job_id,
                    userId=user_id,
                    mode=Ingestionmode.SINGLE_URL,
                    cvVersionId=cv_version_id,
                    maxOffers=1,
                    status=Ingestionjobstatus.PENDING,
                    updatedAt=_now(),
                )
            )
            await session.commit()
    finally:
        await engine.dispose()
    return ingestion_job_id


async def _set_markdown(cv_version_id: str, markdown: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            row = await session.get(CVVersion, cv_version_id)
            row.markdownContent = markdown
            row.conversionStatus = Cvconversionstatus.CONVERTED
            await session.commit()
    finally:
        await engine.dispose()


async def _set_conversion_status(cv_version_id: str, status: Cvconversionstatus) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            row = await session.get(CVVersion, cv_version_id)
            row.conversionStatus = status
            await session.commit()
    finally:
        await engine.dispose()


async def _set_conversion_failed(cv_version_id: str, error: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            row = await session.get(CVVersion, cv_version_id)
            row.conversionStatus = Cvconversionstatus.FAILED
            row.conversionError = error
            await session.commit()
    finally:
        await engine.dispose()


async def _get_cv_version(cv_version_id: str) -> CVVersion:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            return await session.get(CVVersion, cv_version_id)
    finally:
        await engine.dispose()


def _drain_cv_conversion_queue() -> list[str]:
    """Receives and deletes everything on the cv-conversion queue, returning the
    message bodies. Keeps the queue clean between tests that assert on it."""
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


def _object_exists(key: str) -> bool:
    s3 = make_s3_client()
    try:
        s3.head_object(Bucket=S3_BUCKET, Key=key)
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise


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
        assert cv_versions[0]["conversionStatus"] == "PENDING"
        assert cv_versions[0]["supersededById"] is None
        assert "parseStatus" not in cv_versions[0]


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


def test_get_markdown_returns_content_and_status(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        before = client.get(f"/v1/cv-versions/{cv_id}/markdown", headers=_headers(user_id))
        assert before.status_code == 200
        assert before.json() == {
            "markdownContent": None,
            "conversionStatus": "PENDING",
            "conversionError": None,
        }

        asyncio.run(_set_markdown(cv_id, "# Jane Doe\n\nStaff Engineer"))

        after = client.get(f"/v1/cv-versions/{cv_id}/markdown", headers=_headers(user_id))
        assert after.status_code == 200
        assert after.json() == {
            "markdownContent": "# Jane Doe\n\nStaff Engineer",
            "conversionStatus": "CONVERTED",
            "conversionError": None,
        }


def test_get_markdown_returns_the_stored_conversion_error(user_id):
    """The Import screen polls this endpoint and has no other way to read why
    a Conversion failed (issue #195)."""
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
        asyncio.run(_set_conversion_failed(cv_id, "no usable text layer"))

        response = client.get(f"/v1/cv-versions/{cv_id}/markdown", headers=_headers(user_id))
        assert response.status_code == 200
        assert response.json() == {
            "markdownContent": None,
            "conversionStatus": "FAILED",
            "conversionError": "no usable text layer",
        }


def test_get_markdown_returns_404_for_other_users_cv(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        other_user_id = asyncio.run(_create_user())
        try:
            response = client.get(
                f"/v1/cv-versions/{cv_id}/markdown", headers=_headers(other_user_id)
            )
            assert response.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_update_markdown_saves_content_and_touches_only_rendition_and_updated_at(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        asyncio.run(_set_markdown(cv_id, "# Jane Doe\n\nStaff Engineer"))

        before = {
            row["id"]: row
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }[cv_id]

        response = client.put(
            f"/v1/cv-versions/{cv_id}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "# Jane Doe\n\nPrincipal Engineer"},
        )
        assert response.status_code == 200
        assert response.json() == {
            "markdownContent": "# Jane Doe\n\nPrincipal Engineer",
            "conversionStatus": "CONVERTED",
            "conversionError": None,
        }

        fetched = client.get(f"/v1/cv-versions/{cv_id}/markdown", headers=_headers(user_id))
        assert fetched.json()["markdownContent"] == "# Jane Doe\n\nPrincipal Engineer"

        after = {
            row["id"]: row
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }[cv_id]
        assert after["updatedAt"] != before["updatedAt"]
        for field in (
            "fileName",
            "fileType",
            "fileKey",
            "fileSizeBytes",
            "conversionStatus",
            "conversionError",
            "supersededById",
        ):
            assert after[field] == before[field]


def test_update_markdown_returns_404_for_other_users_cv(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        asyncio.run(_set_markdown(cv_id, "# Jane Doe"))

        other_user_id = asyncio.run(_create_user())
        try:
            response = client.put(
                f"/v1/cv-versions/{cv_id}/markdown",
                headers=_headers(other_user_id),
                json={"markdownContent": "# Hijacked"},
            )
            assert response.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_update_markdown_returns_404_for_nonexistent_cv(user_id):
    with TestClient(app) as client:
        response = client.put(
            f"/v1/cv-versions/{uuid.uuid4()}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "# Ghost"},
        )
        assert response.status_code == 404


def test_update_markdown_rejects_superseded_cv(user_id):
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        asyncio.run(_set_markdown(old_id, "# Old"))
        client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "New CV",
                "fileName": "new.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 2048,
            },
        )

        response = client.put(
            f"/v1/cv-versions/{old_id}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "# Edited"},
        )
        assert response.status_code == 409
        assert response.json()["detail"] == "This CV version has already been replaced"


def test_update_markdown_rejects_not_yet_converted(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        response = client.put(
            f"/v1/cv-versions/{cv_id}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "# Too early"},
        )
        assert response.status_code == 409

        asyncio.run(_set_conversion_status(cv_id, Cvconversionstatus.FAILED))
        failed_response = client.put(
            f"/v1/cv-versions/{cv_id}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "# Still too early"},
        )
        assert failed_response.status_code == 409


def test_update_markdown_rejects_empty_content(user_id):
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        asyncio.run(_set_markdown(cv_id, "# Jane Doe"))

        response = client.put(
            f"/v1/cv-versions/{cv_id}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "   \n  "},
        )
        assert response.status_code == 400

        unchanged = client.get(f"/v1/cv-versions/{cv_id}/markdown", headers=_headers(user_id))
        assert unchanged.json()["markdownContent"] == "# Jane Doe"


def test_update_markdown_sends_no_queue_message(user_id):
    _drain_cv_conversion_queue()
    with TestClient(app) as client:
        cv_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.md",
                "contentType": "text/markdown",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        asyncio.run(_set_markdown(cv_id, "# Jane Doe"))
        _drain_cv_conversion_queue()

        response = client.put(
            f"/v1/cv-versions/{cv_id}/markdown",
            headers=_headers(user_id),
            json={"markdownContent": "# Jane Doe, edited"},
        )
        assert response.status_code == 200
        assert _drain_cv_conversion_queue() == []


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


def test_convert_sets_pending_and_enqueues(user_id):
    _drain_cv_conversion_queue()
    with TestClient(app) as client:
        created = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()
        cv_id = created["cvVersionId"]
        make_s3_client().put_object(Bucket=S3_BUCKET, Key=created["fileKey"], Body=b"pdf-bytes")

        asyncio.run(_set_conversion_status(cv_id, Cvconversionstatus.CONVERTED))

        response = client.post(f"/v1/cv-versions/{cv_id}/convert", headers=_headers(user_id))
        assert response.status_code == 202
        assert response.json() == {"conversionStatus": "PENDING"}

        listed = client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        assert listed[0]["conversionStatus"] == "PENDING"

        bodies = [json.loads(b) for b in _drain_cv_conversion_queue()]
        assert bodies == [{"cvVersionId": cv_id}]


def test_convert_returns_409_while_converting(user_id):
    _drain_cv_conversion_queue()
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

        asyncio.run(_set_conversion_status(cv_id, Cvconversionstatus.CONVERTING))

        response = client.post(f"/v1/cv-versions/{cv_id}/convert", headers=_headers(user_id))
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "CONVERSION_RUNNING"
        assert _drain_cv_conversion_queue() == []


def test_convert_rejects_when_the_file_was_never_uploaded(user_id):
    """docs/adr/0028: the file first, the Conversion second. A convert call for
    a fileKey with no object behind it (the browser's PUT never happened, or
    has not happened yet) is refused, and the row is left exactly as it was."""
    _drain_cv_conversion_queue()
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

        asyncio.run(_set_conversion_failed(cv_id, "previous failure"))

        response = client.post(f"/v1/cv-versions/{cv_id}/convert", headers=_headers(user_id))
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "FILE_NOT_UPLOADED"

        row = asyncio.run(_get_cv_version(cv_id))
        assert row.conversionStatus == Cvconversionstatus.FAILED
        assert row.conversionError == "previous failure"
        assert _drain_cv_conversion_queue() == []


def test_convert_returns_404_for_other_users_cv(user_id):
    _drain_cv_conversion_queue()
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
            response = client.post(
                f"/v1/cv-versions/{cv_id}/convert", headers=_headers(other_user_id)
            )
            assert response.status_code == 404
            assert _drain_cv_conversion_queue() == []
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_delete_cv_version_removes_the_s3_object(user_id):
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        )
        cv_id = create_response.json()["cvVersionId"]
        file_key = create_response.json()["fileKey"]

        s3 = make_s3_client()
        s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=b"pdf-bytes")
        assert _object_exists(file_key)

        response = client.delete(f"/v1/cv-versions/{cv_id}", headers=_headers(user_id))
        assert response.status_code == 204
        assert not _object_exists(file_key)


def test_delete_cv_version_does_not_fail_when_the_s3_object_is_already_gone(user_id):
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        )
        cv_id = create_response.json()["cvVersionId"]

        # No object was ever uploaded to this fileKey (e.g. the browser upload
        # never completed) — deleting the row must still succeed.
        response = client.delete(f"/v1/cv-versions/{cv_id}", headers=_headers(user_id))
        assert response.status_code == 204


def test_replace_cv_version_creates_new_row_and_supersedes_old(user_id):
    _drain_cv_conversion_queue()
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        response = client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "New CV",
                "fileName": "new.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        )
        assert response.status_code == 201
        body = response.json()
        new_id = body["cvVersionId"]
        assert new_id != old_id
        assert body["fileKey"] == f"cvs/{user_id}/{new_id}/new.pdf"
        assert body["uploadUrl"]

        listed = {
            row["id"]: row
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert listed[old_id]["supersededById"] == new_id
        assert listed[new_id]["label"] == "New CV"
        assert listed[new_id]["supersededById"] is None
        assert listed[new_id]["conversionStatus"] == "PENDING"

        # docs/adr/0028: the bytes are not in storage yet when replace returns,
        # so the client starts the Conversion after its own PUT.
        assert _drain_cv_conversion_queue() == []


def test_replace_cv_version_transfers_default_status(user_id):
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        client.patch(f"/v1/cv-versions/{old_id}", headers=_headers(user_id), json={"isDefault": True})

        new_id = client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "New CV",
                "fileName": "new.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        ).json()["cvVersionId"]

        listed = {
            row["id"]: row
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert listed[old_id]["isDefault"] is False
        assert listed[new_id]["isDefault"] is True


def test_replace_cv_version_does_not_set_default_when_old_was_not_default(user_id):
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        new_id = client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "New CV",
                "fileName": "new.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        ).json()["cvVersionId"]

        listed = {
            row["id"]: row
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert listed[new_id]["isDefault"] is False


def test_replace_cv_version_returns_404_for_other_users_cv(user_id):
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        other_user_id = asyncio.run(_create_user())
        try:
            response = client.post(
                f"/v1/cv-versions/{old_id}/replace",
                headers=_headers(other_user_id),
                json={
                    "label": "Hijack CV",
                    "fileName": "new.pdf",
                    "contentType": "application/pdf",
                    "fileSizeBytes": 2048,
                },
            )
            assert response.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_replace_cv_version_returns_404_for_nonexistent_cv(user_id):
    with TestClient(app) as client:
        response = client.post(
            f"/v1/cv-versions/{uuid.uuid4()}/replace",
            headers=_headers(user_id),
            json={
                "label": "New CV",
                "fileName": "new.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        )
        assert response.status_code == 404


def test_replace_cv_version_rejects_already_superseded_cv(user_id):
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]
        client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "New CV",
                "fileName": "new.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        )

        response = client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "Another CV",
                "fileName": "another.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        )
        assert response.status_code == 409


def test_replace_cv_version_validates_like_create(user_id):
    with TestClient(app) as client:
        old_id = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "Old CV",
                "fileName": "old.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        ).json()["cvVersionId"]

        response = client.post(
            f"/v1/cv-versions/{old_id}/replace",
            headers=_headers(user_id),
            json={
                "label": "   ",
                "fileName": "new.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 2048,
            },
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "label is required"


def test_delete_cv_version_blocked_while_generated_document_references_it(user_id):
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/cv-versions",
            headers=_headers(user_id),
            json={
                "label": "CV 1",
                "fileName": "cv1.pdf",
                "contentType": "application/pdf",
                "fileSizeBytes": 1024,
            },
        )
        cv_id = create_response.json()["cvVersionId"]

        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv_id, status=Analysisstatus.COMPLETED)
        )
        generated = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        )
        assert generated.status_code == 202

        # Creating a document also creates an Application against the same
        # Analysis (see #66), which would otherwise trip the pre-existing
        # Application check first. Remove it so this test isolates the new
        # GeneratedDocument check specifically.
        asyncio.run(_delete_applications_for_analysis(analysis_id))

        response = client.delete(f"/v1/cv-versions/{cv_id}", headers=_headers(user_id))
        assert response.status_code == 409
        assert "Cover Letter" in response.json()["detail"]
        assert "Tailored CV" in response.json()["detail"]

        still_there = client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        assert any(row["id"] == cv_id for row in still_there)


# --- Whole-chain delete (docs/adr/0027) ---
# "Supprimer un CV" removes the whole supersede chain the targeted CVVersion
# belongs to, not just that one row, and is only permitted when no chain
# member has been used in an Analysis or IngestionJob (Cascade FKs
# docs/adr/0005 flagged) — the gap the single-row Scout/Application/
# GeneratedDocument (Restrict FK) checks above never covered.


def _create_cv(client: TestClient, user_id: str, *, label: str = "CV", file_name: str = "cv.pdf") -> dict:
    return client.post(
        "/v1/cv-versions",
        headers=_headers(user_id),
        json={
            "label": label,
            "fileName": file_name,
            "contentType": "application/pdf",
            "fileSizeBytes": 1024,
        },
    ).json()


def _replace_cv(client: TestClient, user_id: str, old_id: str, *, file_name: str) -> dict:
    return client.post(
        f"/v1/cv-versions/{old_id}/replace",
        headers=_headers(user_id),
        json={
            "label": "CV",
            "fileName": file_name,
            "contentType": "application/pdf",
            "fileSizeBytes": 1024,
        },
    ).json()


def test_delete_cv_removes_every_version_in_the_chain(user_id):
    with TestClient(app) as client:
        v1 = _create_cv(client, user_id, file_name="v1.pdf")
        v2 = _replace_cv(client, user_id, v1["cvVersionId"], file_name="v2.pdf")
        v3 = _replace_cv(client, user_id, v2["cvVersionId"], file_name="v3.pdf")
        chain = [v1, v2, v3]

        s3 = make_s3_client()
        for row in chain:
            s3.put_object(Bucket=S3_BUCKET, Key=row["fileKey"], Body=b"pdf-bytes")

        response = client.delete(
            f"/v1/cv-versions/{v3['cvVersionId']}", headers=_headers(user_id)
        )
        assert response.status_code == 204

        remaining_ids = {
            row["id"]
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert remaining_ids.isdisjoint({row["cvVersionId"] for row in chain})
        for row in chain:
            assert not _object_exists(row["fileKey"])


def test_delete_cv_via_a_superseded_members_id_removes_the_whole_chain(user_id):
    """The web client only ever triggers this from the current (non-
    superseded) row, but the API resolves the same chain regardless of which
    member's id it's called with (docs/adr/0027)."""
    with TestClient(app) as client:
        old = _create_cv(client, user_id, file_name="old.pdf")
        new = _replace_cv(client, user_id, old["cvVersionId"], file_name="new.pdf")

        response = client.delete(
            f"/v1/cv-versions/{old['cvVersionId']}", headers=_headers(user_id)
        )
        assert response.status_code == 204

        remaining_ids = {
            row["id"]
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert remaining_ids.isdisjoint({old["cvVersionId"], new["cvVersionId"]})


def test_delete_cv_blocked_when_an_older_version_was_analysed(user_id):
    with TestClient(app) as client:
        old = _create_cv(client, user_id, file_name="old.pdf")
        asyncio.run(
            _seed_analysis(
                user_id=user_id, cv_version_id=old["cvVersionId"], status=Analysisstatus.COMPLETED
            )
        )
        new = _replace_cv(client, user_id, old["cvVersionId"], file_name="new.pdf")

        # The Analysis is against the now-superseded version, not the
        # current one the delete was called with — the check must still
        # catch it, since it's the same CV (docs/adr/0027).
        response = client.delete(
            f"/v1/cv-versions/{new['cvVersionId']}", headers=_headers(user_id)
        )
        assert response.status_code == 409
        assert "Analysis" in response.json()["detail"]

        remaining_ids = {
            row["id"]
            for row in client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        }
        assert {old["cvVersionId"], new["cvVersionId"]} <= remaining_ids


def test_delete_cv_blocked_by_analysis_regardless_of_status(user_id):
    with TestClient(app) as client:
        cv = _create_cv(client, user_id)
        # PENDING, not COMPLETED — still real history a delete must not
        # silently wipe out (docs/adr/0027).
        asyncio.run(
            _seed_analysis(
                user_id=user_id, cv_version_id=cv["cvVersionId"], status=Analysisstatus.PENDING
            )
        )

        response = client.delete(f"/v1/cv-versions/{cv['cvVersionId']}", headers=_headers(user_id))
        assert response.status_code == 409
        assert "Analysis" in response.json()["detail"]


def test_delete_cv_blocked_when_chain_member_referenced_by_ingestion_job(user_id):
    with TestClient(app) as client:
        cv = _create_cv(client, user_id)
        asyncio.run(_seed_ingestion_job(user_id=user_id, cv_version_id=cv["cvVersionId"]))

        response = client.delete(f"/v1/cv-versions/{cv['cvVersionId']}", headers=_headers(user_id))
        assert response.status_code == 409
        assert "ingestion job" in response.json()["detail"]

        still_there = client.get("/v1/cv-versions", headers=_headers(user_id)).json()["cvVersions"]
        assert any(row["id"] == cv["cvVersionId"] for row in still_there)


def test_delete_cv_succeeds_even_when_it_is_the_default_cv(user_id):
    with TestClient(app) as client:
        cv = _create_cv(client, user_id)
        client.patch(
            f"/v1/cv-versions/{cv['cvVersionId']}",
            headers=_headers(user_id),
            json={"isDefault": True},
        )

        response = client.delete(f"/v1/cv-versions/{cv['cvVersionId']}", headers=_headers(user_id))
        assert response.status_code == 204


def test_delete_cv_returns_404_for_other_users_cv(user_id):
    with TestClient(app) as client:
        cv = _create_cv(client, user_id)

        other_user_id = asyncio.run(_create_user())
        try:
            response = client.delete(
                f"/v1/cv-versions/{cv['cvVersionId']}", headers=_headers(other_user_id)
            )
            assert response.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_delete_cv_returns_404_for_nonexistent_cv(user_id):
    with TestClient(app) as client:
        response = client.delete(f"/v1/cv-versions/{uuid.uuid4()}", headers=_headers(user_id))
        assert response.status_code == 404
