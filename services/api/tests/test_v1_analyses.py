import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    IngestionJob,
    Ingestionjobstatus,
    Ingestionmode,
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
from api.sqs_client import ANALYSIS_INTAKE_QUEUE_URL, make_sqs_client

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
    # Analysis/CVVersion.userId both have ondelete=CASCADE, so this also
    # removes any rows created for the user during the test.
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


def _purge_queue() -> None:
    sqs = make_sqs_client()
    while True:
        received = sqs.receive_message(QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, MaxNumberOfMessages=10)
        messages = received.get("Messages", [])
        if not messages:
            break
        for message in messages:
            sqs.delete_message(QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, ReceiptHandle=message["ReceiptHandle"])


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


@pytest.fixture(autouse=True)
def _clean_queue():
    _purge_queue()
    yield
    _purge_queue()


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
    """Temporarily overrides FREE's `PlanQuotaDefault` for `kind` — `user_id`
    above creates a plain FREE-plan User (issue #135), so this is the
    fixture cap tests use instead of the retired `DAILY_ANALYSIS_CAP` env var
    (issue #136).
    """
    original = asyncio.run(_free_plan_default(kind))

    def _apply(limit: int) -> None:
        asyncio.run(_set_free_plan_default(kind, limit))

    yield _apply
    asyncio.run(_set_free_plan_default(kind, original))


@pytest.fixture
def analyses_daily_cap():
    yield from _plan_cap_fixture(Quotakind.ANALYSES_DAILY)


@pytest.fixture
def analyses_monthly_cap():
    yield from _plan_cap_fixture(Quotakind.ANALYSES_MONTHLY)


def test_create_analysis_requires_user_id_header(job_offer_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyses",
            headers=INTERNAL_SECRET_HEADERS,
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert response.status_code == 401


def test_create_analysis_rejects_unknown_job_offer(user_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": str(uuid.uuid4()), "cvVersionId": cv_version_id},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown jobOfferId"


def test_create_analysis_rejects_cv_version_owned_by_another_user(job_offer_id, user_id):
    other_user_id = asyncio.run(_create_user())
    other_cv_version_id = asyncio.run(_create_cv_version(other_user_id))
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/analyses",
                headers=_headers(user_id),
                json={"jobOfferId": job_offer_id, "cvVersionId": other_cv_version_id},
            )
        assert response.status_code == 400
        assert response.json()["detail"] == "Unknown cvVersionId"
    finally:
        asyncio.run(_delete_user(other_user_id))


def test_create_analysis_success_creates_row_and_enqueues_sqs_message(user_id, job_offer_id, cv_version_id):
    with TestClient(app) as client:
        response = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert response.status_code == 202
    analysis_id = response.json()["analysisId"]
    assert analysis_id

    sqs = make_sqs_client()
    received = sqs.receive_message(QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=2)
    messages = received.get("Messages", [])
    assert len(messages) == 1
    assert json.loads(messages[0]["Body"]) == {"analysisId": analysis_id}


def test_create_analysis_returns_429_once_daily_cap_reached(
    analyses_daily_cap, user_id, job_offer_id, cv_version_id
):
    analyses_daily_cap(1)
    with TestClient(app) as client:
        first = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        assert first.status_code == 202

        second = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert second.status_code == 429
    assert "Daily analysis limit of 1 reached" in second.json()["detail"]


def test_create_analysis_returns_429_once_monthly_cap_reached(
    analyses_monthly_cap, user_id, job_offer_id, cv_version_id
):
    analyses_monthly_cap(1)
    with TestClient(app) as client:
        first = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
        assert first.status_code == 202

        second = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        )
    assert second.status_code == 429
    assert "Monthly analysis limit of 1 reached" in second.json()["detail"]


def test_list_and_get_analyses_scoped_to_caller(user_id, job_offer_id, cv_version_id):
    with TestClient(app) as client:
        created = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()
        analysis_id = created["analysisId"]

        list_response = client.get("/v1/analyses", headers=_headers(user_id))
        assert list_response.status_code == 200
        analyses = list_response.json()["analyses"]
        assert len(analyses) == 1
        assert analyses[0]["id"] == analysis_id
        assert analyses[0]["status"] == "PENDING"
        assert analyses[0]["jobOffer"]["id"] == job_offer_id
        assert analyses[0]["cvVersion"]["id"] == cv_version_id

        filtered_response = client.get(
            "/v1/analyses", headers=_headers(user_id), params={"jobOfferId": job_offer_id}
        )
        assert filtered_response.status_code == 200
        assert len(filtered_response.json()["analyses"]) == 1

        get_response = client.get(f"/v1/analyses/{analysis_id}", headers=_headers(user_id))
        assert get_response.status_code == 200
        assert get_response.json()["analysis"]["id"] == analysis_id

        other_user_id = asyncio.run(_create_user())
        try:
            other_list = client.get("/v1/analyses", headers=_headers(other_user_id))
            assert other_list.json()["analyses"] == []

            other_get = client.get(f"/v1/analyses/{analysis_id}", headers=_headers(other_user_id))
            assert other_get.status_code == 404
        finally:
            asyncio.run(_delete_user(other_user_id))


async def _link_analysis_to_new_ingestion_job(
    user_id: str,
    analysis_id: str,
    *,
    mode: Ingestionmode = Ingestionmode.SINGLE_URL,
    site_config_id: str | None = None,
) -> str:
    """Creates an IngestionJob owned by `user_id` and stamps its id onto
    `analysis_id`'s ingestionJobId (the worker does this in the real flow)."""
    ingestion_job_id = str(uuid.uuid4())
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(
                IngestionJob(
                    id=ingestion_job_id,
                    userId=user_id,
                    mode=mode,
                    siteConfigId=site_config_id,
                    maxOffers=1,
                    status=Ingestionjobstatus.PENDING,
                    updatedAt=_now(),
                )
            )
            analysis = await session.get(Analysis, analysis_id)
            analysis.ingestionJobId = ingestion_job_id
            await session.commit()
    finally:
        await engine.dispose()
    return ingestion_job_id


def test_list_analyses_filters_by_ingestion_job_id(user_id, job_offer_id, cv_version_id):
    with TestClient(app) as client:
        batched_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]
        standalone_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]

        ingestion_job_id = asyncio.run(_link_analysis_to_new_ingestion_job(user_id, batched_id))

        filtered = client.get(
            "/v1/analyses",
            headers=_headers(user_id),
            params={"ingestionJobId": ingestion_job_id},
        )
        assert filtered.status_code == 200
        ids = [a["id"] for a in filtered.json()["analyses"]]
        assert ids == [batched_id]
        assert standalone_id not in ids

        other_user_id = asyncio.run(_create_user())
        try:
            other = client.get(
                "/v1/analyses",
                headers=_headers(other_user_id),
                params={"ingestionJobId": ingestion_job_id},
            )
            assert other.json()["analyses"] == []
        finally:
            asyncio.run(_delete_user(other_user_id))


def test_list_analyses_exposes_ingestion_job_ref_for_grouping(
    user_id, job_offer_id, cv_version_id
):
    """The Dashboard folds a SITE_SEARCH batch into one row (issue #34): each
    Analysis row carries `ingestionJobId` plus a nested `{mode, siteConfigId}`
    for rows that came from an IngestionJob, and `null` for a standalone one."""
    with TestClient(app) as client:
        batched_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]
        standalone_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]

        ingestion_job_id = asyncio.run(
            _link_analysis_to_new_ingestion_job(
                user_id,
                batched_id,
                mode=Ingestionmode.SITE_SEARCH,
                site_config_id="site-ft",
            )
        )

        rows = {a["id"]: a for a in client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]}

        assert rows[batched_id]["ingestionJobId"] == ingestion_job_id
        assert rows[batched_id]["ingestionJob"] == {
            "mode": "SITE_SEARCH",
            "siteConfigId": "site-ft",
        }
        assert rows[standalone_id]["ingestionJobId"] is None
        assert rows[standalone_id]["ingestionJob"] is None

        detail = client.get(f"/v1/analyses/{batched_id}", headers=_headers(user_id)).json()["analysis"]
        assert detail["ingestionJob"]["mode"] == "SITE_SEARCH"


def test_get_analysis_returns_404_for_unknown_id(user_id):
    with TestClient(app) as client:
        response = client.get(f"/v1/analyses/{uuid.uuid4()}", headers=_headers(user_id))
    assert response.status_code == 404


async def _stamp_scout_id(analysis_id: str, scout_id: str) -> None:
    """Denormalised `Analysis.scoutId` (no FK) — the ingestion fan-out sets this
    for a Scout-driven analysis; stamp it directly here."""
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            analysis = await session.get(Analysis, analysis_id)
            analysis.scoutId = scout_id
            await session.commit()
    finally:
        await engine.dispose()


def test_list_and_get_analyses_expose_application_status(user_id, job_offer_id, cv_version_id):
    """The Analyses table derives its 5-bucket Tracking status (issue #64)
    from the linked Application's status, exposed here without a second
    fetch/join: `null` before an Application exists, then live as it moves."""
    with TestClient(app) as client:
        analysis_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]

        rows = {
            a["id"]: a
            for a in client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]
        }
        assert rows[analysis_id]["applicationStatus"] is None
        detail = client.get(f"/v1/analyses/{analysis_id}", headers=_headers(user_id)).json()["analysis"]
        assert detail["applicationStatus"] is None

        application_id = client.post(
            "/v1/applications",
            headers=_headers(user_id),
            json={"analysisId": analysis_id},
        ).json()["application"]["id"]

        rows = {
            a["id"]: a
            for a in client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]
        }
        assert rows[analysis_id]["applicationStatus"] == "DRAFT"

        client.post(
            f"/v1/applications/{application_id}/status-events",
            headers=_headers(user_id),
            json={"status": "APPLIED"},
        )

        rows = {
            a["id"]: a
            for a in client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]
        }
        assert rows[analysis_id]["applicationStatus"] == "APPLIED"
        detail = client.get(f"/v1/analyses/{analysis_id}", headers=_headers(user_id)).json()["analysis"]
        assert detail["applicationStatus"] == "APPLIED"


def test_list_and_get_analyses_expose_scout_id(user_id, job_offer_id, cv_version_id):
    """A Scout-driven Analysis shows in `/analyses` tagged with its Scout
    (issue #54); a manual one carries `scoutId: null`."""
    with TestClient(app) as client:
        scouted_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]
        manual_id = client.post(
            "/v1/analyses",
            headers=_headers(user_id),
            json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
        ).json()["analysisId"]

        asyncio.run(_stamp_scout_id(scouted_id, "scout-xyz"))

        rows = {
            a["id"]: a
            for a in client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]
        }
        assert rows[scouted_id]["scoutId"] == "scout-xyz"
        assert rows[manual_id]["scoutId"] is None

        detail = client.get(
            f"/v1/analyses/{scouted_id}", headers=_headers(user_id)
        ).json()["analysis"]
        assert detail["scoutId"] == "scout-xyz"


# --- POST /v1/analyses/{id}/requeue (docs/adr/0032) ---
# Re-drives a stuck Analysis in place instead of creating a new one: a worker or
# ElasticMQ restart drops the queued message and leaves the row non-terminal
# with nothing coming for it. The staleness rule itself is pinned by
# test_stuck_analysis_helper.py; these cover the HTTP contract.


async def _age_analysis(analysis_id: str, *, requested_minutes_ago: int, started: bool) -> None:
    """Backdate an Analysis so the staleness rule sees it as abandoned, and put
    it in the requested non-terminal shape. `started=True` is the mid-flight case
    (RUNNING_CREW with a startedAt), `False` the queued case (PENDING)."""
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            analysis = await session.get(Analysis, analysis_id)
            moment = _now() - timedelta(minutes=requested_minutes_ago)
            analysis.requestedAt = moment
            if started:
                analysis.status = Analysisstatus.RUNNING_CREW
                analysis.startedAt = moment
            else:
                analysis.status = Analysisstatus.PENDING
                analysis.startedAt = None
            await session.commit()
    finally:
        await engine.dispose()


async def _set_terminal(analysis_id: str, status: Analysisstatus) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            analysis = await session.get(Analysis, analysis_id)
            analysis.status = status
            await session.commit()
    finally:
        await engine.dispose()


async def _read_analysis(analysis_id: str) -> dict:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            row = await session.get(Analysis, analysis_id)
            return {
                "status": row.status,
                "errorMessage": row.errorMessage,
                "startedAt": row.startedAt,
                "requeuedAt": row.requeuedAt,
                "requestedAt": row.requestedAt,
            }
    finally:
        await engine.dispose()


def _create(client, user_id, job_offer_id, cv_version_id) -> str:
    return client.post(
        "/v1/analyses",
        headers=_headers(user_id),
        json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
    ).json()["analysisId"]


def test_requeue_returns_404_for_another_users_analysis(user_id, job_offer_id, cv_version_id):
    """User-scoped like every other analyses route: another user's row is a 404,
    never a 403."""
    other_user_id = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            analysis_id = _create(client, user_id, job_offer_id, cv_version_id)
            asyncio.run(_age_analysis(analysis_id, requested_minutes_ago=180, started=False))

            response = client.post(
                f"/v1/analyses/{analysis_id}/requeue", headers=_headers(other_user_id)
            )
        assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other_user_id))


@pytest.mark.parametrize("status", [Analysisstatus.COMPLETED, Analysisstatus.FAILED])
def test_requeue_refuses_a_terminal_analysis(status, user_id, job_offer_id, cv_version_id):
    """Re-running a finished Analysis is `POST /v1/analyses` (docs/adr/0011): a
    new row, quota charged. Requeue is only for rows that never finished."""
    with TestClient(app) as client:
        analysis_id = _create(client, user_id, job_offer_id, cv_version_id)
        asyncio.run(_set_terminal(analysis_id, status))

        response = client.post(f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ANALYSIS_ALREADY_TERMINAL"


def test_requeue_refuses_an_analysis_that_is_still_being_processed(
    user_id, job_offer_id, cv_version_id
):
    """The row was created moments ago, so nothing is wrong with it. The client
    may offer the button optimistically; the server is the authority."""
    with TestClient(app) as client:
        analysis_id = _create(client, user_id, job_offer_id, cv_version_id)

        response = client.post(f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ANALYSIS_NOT_STUCK"


def test_requeue_resets_the_same_row_and_enqueues_it(user_id, job_offer_id, cv_version_id):
    """The whole point: one row, put back at PENDING and re-enqueued — not a
    second Analysis."""
    with TestClient(app) as client:
        analysis_id = _create(client, user_id, job_offer_id, cv_version_id)
        asyncio.run(_age_analysis(analysis_id, requested_minutes_ago=180, started=True))
        _purge_queue()

        response = client.post(f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id))
        assert response.status_code == 202
        assert response.json()["status"] == "PENDING"

        rows = client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]
        assert [row["id"] for row in rows] == [analysis_id], "no second Analysis was created"

    row = asyncio.run(_read_analysis(analysis_id))
    assert row["status"] == Analysisstatus.PENDING
    assert row["errorMessage"] is None
    assert row["startedAt"] is None, "cleared so the next run stamps a truthful crew start"
    assert row["requeuedAt"] is not None

    sqs = make_sqs_client()
    received = sqs.receive_message(
        QueueUrl=ANALYSIS_INTAKE_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=2
    )
    messages = received.get("Messages", [])
    assert len(messages) == 1
    assert json.loads(messages[0]["Body"]) == {"analysisId": analysis_id}


def test_requeue_does_not_spend_a_quota_slot(analyses_daily_cap, user_id, job_offer_id, cv_version_id):
    """The interruption is ours, and the work was already charged when the row
    was created. With the daily cap at 1, the single analysis is requeueable even
    though a `POST /v1/analyses` would now be refused.

    Guards `requestedAt` specifically: that column is the quota clock
    (py_db/quota.py), which is why requeue stamps `requeuedAt` instead.
    """
    analyses_daily_cap(1)
    with TestClient(app) as client:
        analysis_id = _create(client, user_id, job_offer_id, cv_version_id)
        asyncio.run(_age_analysis(analysis_id, requested_minutes_ago=180, started=True))
        aged_requested_at = asyncio.run(_read_analysis(analysis_id))["requestedAt"]

        assert (
            client.post(
                "/v1/analyses",
                headers=_headers(user_id),
                json={"jobOfferId": job_offer_id, "cvVersionId": cv_version_id},
            ).status_code
            == 429
        ), "the cap is genuinely reached"

        response = client.post(f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id))
    assert response.status_code == 202

    after = asyncio.run(_read_analysis(analysis_id))
    assert after["requestedAt"] == aged_requested_at, (
        "requeue must not touch the quota clock; it stamps requeuedAt instead"
    )
    assert after["requeuedAt"] is not None


def test_requeue_is_refused_twice_in_a_row(user_id, job_offer_id, cv_version_id):
    """The `requeuedAt` stamp restarts the staleness clock, so a second click
    right after the first is refused instead of queueing a duplicate run."""
    with TestClient(app) as client:
        analysis_id = _create(client, user_id, job_offer_id, cv_version_id)
        asyncio.run(_age_analysis(analysis_id, requested_minutes_ago=180, started=True))

        assert (
            client.post(
                f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id)
            ).status_code
            == 202
        )
        second = client.post(f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id))
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "ANALYSIS_NOT_STUCK"


def test_list_and_get_analyses_expose_the_stuck_flag(user_id, job_offer_id, cv_version_id):
    """The flag the Web reads to offer "Relancer l'analyse" — derived on read, so
    both the list and the detail endpoint agree without the client re-deriving it
    from timestamps."""
    with TestClient(app) as client:
        fresh_id = _create(client, user_id, job_offer_id, cv_version_id)
        stuck_id = _create(client, user_id, job_offer_id, cv_version_id)
        asyncio.run(_age_analysis(stuck_id, requested_minutes_ago=180, started=True))

        rows = {
            a["id"]: a
            for a in client.get("/v1/analyses", headers=_headers(user_id)).json()["analyses"]
        }
        assert rows[stuck_id]["stuck"] is True
        assert rows[fresh_id]["stuck"] is False

        detail = client.get(f"/v1/analyses/{stuck_id}", headers=_headers(user_id)).json()[
            "analysis"
        ]
        assert detail["stuck"] is True
        assert detail["requeuedAt"] is None
