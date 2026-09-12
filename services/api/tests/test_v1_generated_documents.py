import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    GeneratedDocument,
    Generateddocumentstatus,
    JobOffer,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app
from api.sqs_client import GENERATION_INTAKE_QUEUE_URL, make_sqs_client

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


@pytest.fixture
def user_id():
    uid = asyncio.run(_create_user())
    yield uid
    asyncio.run(_delete_user(uid))


def _drain_generation_intake() -> list[dict]:
    sqs = make_sqs_client()
    bodies: list[dict] = []
    while True:
        received = sqs.receive_message(QueueUrl=GENERATION_INTAKE_QUEUE_URL, MaxNumberOfMessages=10)
        messages = received.get("Messages", [])
        if not messages:
            break
        for message in messages:
            bodies.append(json.loads(message["Body"]))
            sqs.delete_message(
                QueueUrl=GENERATION_INTAKE_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"]
            )
    return bodies


@pytest.fixture(autouse=True)
def _clean_generation_intake_queue():
    _drain_generation_intake()
    yield
    _drain_generation_intake()


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


def test_create_generated_documents_creates_both_types_and_enqueues(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )

        response = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        )
        assert response.status_code == 202
        body = response.json()
        types = {doc["type"] for doc in body["generatedDocuments"]}
        assert types == {"COVER_LETTER", "TAILORED_CV"}
        for doc in body["generatedDocuments"]:
            assert doc["status"] == "PENDING"
            assert doc["analysisId"] == analysis_id

        enqueued = _drain_generation_intake()
        assert {b["generatedDocumentId"] for b in enqueued} == {
            doc["id"] for doc in body["generatedDocuments"]
        }


def test_create_generated_documents_rejects_a_non_completed_analysis(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.PENDING)
        )

        response = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        )
        assert response.status_code == 400
        assert _drain_generation_intake() == []


def test_create_generated_documents_creates_an_application(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )

        response = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        )
        assert response.status_code == 202

        applications = client.get("/v1/applications", headers=_headers(user_id)).json()[
            "applications"
        ]
        matching = [a for a in applications if a["analysisId"] == analysis_id]
        assert len(matching) == 1
        assert matching[0]["status"] == "DRAFT"


def test_create_generated_documents_does_not_duplicate_an_existing_application(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )

        created = client.post(
            "/v1/applications", headers=_headers(user_id), json={"analysisId": analysis_id}
        ).json()["application"]

        client.post(f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id))

        applications = client.get("/v1/applications", headers=_headers(user_id)).json()[
            "applications"
        ]
        matching = [a for a in applications if a["analysisId"] == analysis_id]
        assert len(matching) == 1
        assert matching[0]["id"] == created["id"]


def test_create_generated_documents_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            response = client.post(
                f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(other)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_list_generated_documents_returns_current_documents_for_the_analysis(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()

        response = client.get(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        )
        assert response.status_code == 200
        ids = {doc["id"] for doc in response.json()["generatedDocuments"]}
        assert ids == {doc["id"] for doc in created["generatedDocuments"]}


def test_list_generated_documents_is_empty_before_generation(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )

        response = client.get(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        )
        assert response.status_code == 200
        assert response.json()["generatedDocuments"] == []


def test_list_generated_documents_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            response = client.get(
                f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(other)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_get_generated_document_returns_the_row(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()
        document_id = created["generatedDocuments"][0]["id"]

        response = client.get(f"/v1/generated-documents/{document_id}", headers=_headers(user_id))
        assert response.status_code == 200
        assert response.json()["generatedDocument"]["id"] == document_id


def test_get_generated_document_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            created = client.post(
                f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
            ).json()
            document_id = created["generatedDocuments"][0]["id"]

            response = client.get(
                f"/v1/generated-documents/{document_id}", headers=_headers(other)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_get_generated_document_missing_id_is_404(user_id):
    with TestClient(app) as client:
        response = client.get(
            f"/v1/generated-documents/{uuid.uuid4()}", headers=_headers(user_id)
        )
        assert response.status_code == 404


async def _mark_document_ready(document_id: str, markdown_content: str) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            document = await session.get(GeneratedDocument, document_id)
            document.status = Generateddocumentstatus.READY
            document.markdownContent = markdown_content
            await session.commit()
    finally:
        await engine.dispose()


def test_get_generated_document_pdf_returns_rendered_pdf_bytes(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()
        document_id = created["generatedDocuments"][0]["id"]
        asyncio.run(_mark_document_ready(document_id, "# Cover Letter\n\nDear hiring manager."))

        response = client.get(
            f"/v1/generated-documents/{document_id}/pdf", headers=_headers(user_id)
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF")


def test_get_generated_document_pdf_rejects_a_document_not_yet_ready(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()
        document_id = created["generatedDocuments"][0]["id"]

        response = client.get(
            f"/v1/generated-documents/{document_id}/pdf", headers=_headers(user_id)
        )
        assert response.status_code == 400


def test_get_generated_document_pdf_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            created = client.post(
                f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
            ).json()
            document_id = created["generatedDocuments"][0]["id"]
            asyncio.run(_mark_document_ready(document_id, "Some content."))

            response = client.get(
                f"/v1/generated-documents/{document_id}/pdf", headers=_headers(other)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_regenerate_generated_document_supersedes_and_enqueues(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()
        document_id = created["generatedDocuments"][0]["id"]
        doc_type = created["generatedDocuments"][0]["type"]
        asyncio.run(_mark_document_ready(document_id, "# Cover Letter\n\nDear hiring manager."))
        _drain_generation_intake()

        response = client.post(
            f"/v1/generated-documents/{document_id}/regenerate", headers=_headers(user_id)
        )
        assert response.status_code == 202
        new_document = response.json()["generatedDocument"]
        assert new_document["id"] != document_id
        assert new_document["type"] == doc_type
        assert new_document["status"] == "PENDING"

        enqueued = _drain_generation_intake()
        assert {b["generatedDocumentId"] for b in enqueued} == {new_document["id"]}

        listed = client.get(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()["generatedDocuments"]
        listed_ids = {doc["id"] for doc in listed}
        assert new_document["id"] in listed_ids
        assert document_id not in listed_ids


def test_regenerate_generated_document_rejects_one_already_in_progress(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()
        document_id = created["generatedDocuments"][0]["id"]
        _drain_generation_intake()

        response = client.post(
            f"/v1/generated-documents/{document_id}/regenerate", headers=_headers(user_id)
        )
        assert response.status_code == 409
        assert _drain_generation_intake() == []


def test_regenerate_generated_document_is_user_scoped(user_id):
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            analysis_id = asyncio.run(
                _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
            )
            created = client.post(
                f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
            ).json()
            document_id = created["generatedDocuments"][0]["id"]
            asyncio.run(_mark_document_ready(document_id, "Some content."))

            response = client.post(
                f"/v1/generated-documents/{document_id}/regenerate", headers=_headers(other)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_regenerate_generated_document_respects_daily_generation_cap(user_id, monkeypatch):
    monkeypatch.setenv("DAILY_GENERATION_CAP", "2")
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        analysis_id = asyncio.run(
            _seed_analysis(user_id=user_id, cv_version_id=cv, status=Analysisstatus.COMPLETED)
        )
        created = client.post(
            f"/v1/analyses/{analysis_id}/generated-documents", headers=_headers(user_id)
        ).json()
        # The initial create already produced 2 rows (COVER_LETTER + TAILORED_CV),
        # exhausting a cap of 2 for the day.
        document_id = created["generatedDocuments"][0]["id"]
        asyncio.run(_mark_document_ready(document_id, "Some content."))
        _drain_generation_intake()

        response = client.post(
            f"/v1/generated-documents/{document_id}/regenerate", headers=_headers(user_id)
        )
        assert response.status_code == 429
        assert _drain_generation_intake() == []
