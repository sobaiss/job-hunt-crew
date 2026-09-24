"""Run state on the Scout contract (issue #225, docs/adr/0033).

Every test seeds pipeline rows at controlled ages and asserts only what a
client reads off `GET /v1/scouts` or `GET /v1/scouts/{id}`: `runState`,
`runStateSince` and `blockedAnalysisIds`.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    IngestionJob,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Joboffersourcesite,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, update

from api.main import app

INTERNAL_SECRET_HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")
    # Pin the three thresholds the rule reads, so the ages below mean what
    # they say whatever the developer's shell exports.
    monkeypatch.setenv("ANALYSIS_STUCK_AFTER_MINUTES", "15")
    monkeypatch.setenv("SCOUT_QUEUED_BLOCKED_AFTER_MINUTES", "120")
    monkeypatch.setenv("SCOUT_RUN_STUCK_AFTER_MINUTES", "20")


def _headers(user_id: str) -> dict[str, str]:
    return {**INTERNAL_SECRET_HEADERS, "X-User-Id": user_id}


def _now() -> datetime:
    # Millisecond precision, like the TIMESTAMP(3) columns, so a seeded clock
    # round-trips exactly and `runStateSince` can be compared for equality.
    now = datetime.now(UTC).replace(tzinfo=None)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


def _ago(minutes: float) -> datetime:
    return _now() - timedelta(minutes=minutes)


async def _in_session(fn) -> None:
    engine = make_engine()
    try:
        async with make_session_factory(engine)() as session:
            await fn(session)
            await session.commit()
    finally:
        await engine.dispose()


async def _create_user() -> str:
    user_id = str(uuid.uuid4())

    async def add(session):
        session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))

    await _in_session(add)
    return user_id


async def _delete_user(user_id: str) -> None:
    async def remove(session):
        await session.execute(delete(User).where(User.id == user_id))

    await _in_session(remove)


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


def _make_scout(
    client: TestClient, user_id: str, cv_version_id: str, *, paused: bool = False
) -> str:
    response = client.post(
        "/v1/scouts",
        headers=_headers(user_id),
        json={
            "label": f"Scout {uuid.uuid4()}",
            "cvVersionId": cv_version_id,
            "targetSiteKeys": ["FRANCE_TRAVAIL"],
            "filters": {"keywords": "python"},
        },
    )
    assert response.status_code == 201
    scout_id = response.json()["scout"]["id"]
    if paused:
        # Keeps a many-Scout test under the active-Scouts cap; Run state is
        # independent of the lifecycle.
        paused_response = client.patch(
            f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={"status": "PAUSED"}
        )
        assert paused_response.status_code == 200
    return scout_id


def _seed_run(
    scout_id: str,
    status: Scoutrunstatus,
    *,
    created_at: datetime,
    started_at: datetime | None = None,
    failed_count: int = 0,
) -> str:
    """A ScoutRun as `dispatch_scout_run` leaves it, with `Scout.lastRunAt`
    stamped the way the dispatcher stamps it once the run has been picked up."""
    run_id = str(uuid.uuid4())

    async def add(session):
        session.add(
            ScoutRun(
                id=run_id,
                scoutId=scout_id,
                status=status,
                createdAt=created_at,
                startedAt=started_at,
                failedCount=failed_count,
            )
        )
        if status != Scoutrunstatus.PENDING:
            await session.execute(
                update(Scout)
                .where(Scout.id == scout_id)
                .values(lastRunAt=started_at or created_at)
            )

    asyncio.run(_in_session(add))
    return run_id


def _seed_ingestion_job(
    user_id: str, scout_run_id: str, status: Ingestionjobstatus, *, created_at: datetime
) -> str:
    job_id = str(uuid.uuid4())

    async def add(session):
        session.add(
            IngestionJob(
                id=job_id,
                userId=user_id,
                mode=Ingestionmode.SITE_SEARCH,
                status=status,
                scoutRunId=scout_run_id,
                createdAt=created_at,
                updatedAt=created_at,
            )
        )

    asyncio.run(_in_session(add))
    return job_id


def _seed_analysis(
    user_id: str,
    cv_version_id: str,
    scout_id: str,
    status: Analysisstatus,
    *,
    requested_at: datetime,
    started_at: datetime | None = None,
    requeued_at: datetime | None = None,
) -> str:
    """An Analysis reached by its denormalised `scoutId`, as the ingestion
    fan-out creates them. No IngestionJob: the rule does not go through one."""
    job_offer_id = str(uuid.uuid4())
    analysis_id = str(uuid.uuid4())

    async def add(session):
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
                requestedAt=requested_at,
                startedAt=started_at,
                requeuedAt=requeued_at,
            )
        )

    asyncio.run(_in_session(add))
    return analysis_id


def _scout(client: TestClient, user_id: str, scout_id: str) -> dict:
    response = client.get(f"/v1/scouts/{scout_id}", headers=_headers(user_id))
    assert response.status_code == 200
    return response.json()["scout"]


def _since(scout: dict) -> datetime | None:
    raw = scout["runStateSince"]
    return None if raw is None else datetime.fromisoformat(raw).replace(tzinfo=None)


def _finished_run(scout_id: str, **kwargs) -> str:
    """A cleanly completed run from an hour ago — the healthy background most
    tests layer their situation on top of."""
    return _seed_run(
        scout_id,
        kwargs.pop("status", Scoutrunstatus.COMPLETED),
        created_at=_ago(60),
        started_at=_ago(60),
        **kwargs,
    )


# --- Every state, one situation each ---------------------------------------


def test_a_scout_that_has_never_run_reads_never_run(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        created = client.post(
            "/v1/scouts",
            headers=_headers(user_id),
            json={"label": "New", "cvVersionId": cv, "targetSiteKeys": ["FRANCE_TRAVAIL"]},
        ).json()["scout"]

        assert created["runState"] == "NEVER_RUN"
        assert created["runStateSince"] is None
        assert created["blockedAnalysisIds"] == []
        assert _scout(client, user_id, created["id"])["runState"] == "NEVER_RUN"


def test_a_healthy_scout_reads_ok(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        _seed_analysis(user_id, cv, scout_id, Analysisstatus.COMPLETED, requested_at=_ago(50))

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "OK"
        assert scout["runStateSince"] is None
        assert scout["blockedAnalysisIds"] == []


def test_a_queued_run_reads_in_flight_from_the_click(user_id):
    """The fan-out has not started yet: no lastRunAt, no job, no analysis —
    only the PENDING run the "Run now" click created."""
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        created_at = _ago(0.1)
        _seed_run(scout_id, Scoutrunstatus.PENDING, created_at=created_at)

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert _since(scout) == created_at


def test_a_fanning_out_run_reads_in_flight(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        started_at = _ago(1)
        _seed_run(scout_id, Scoutrunstatus.RUNNING, created_at=_ago(2), started_at=started_at)

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert _since(scout) == started_at


def test_the_scrape_phase_reads_in_flight_after_the_run_row_went_terminal(user_id):
    """`ScoutRun.status` is COMPLETED seconds into a run; the ingestion job
    is what carries the scrape phase."""
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        run_id = _seed_run(
            scout_id, Scoutrunstatus.COMPLETED, created_at=_ago(5), started_at=_ago(5)
        )
        job_created_at = _ago(4)
        _seed_ingestion_job(user_id, run_id, Ingestionjobstatus.RUNNING, created_at=job_created_at)

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert _since(scout) == job_created_at


def test_the_analysis_phase_reads_in_flight_after_the_jobs_went_terminal(user_id):
    """A queued row forty minutes old is past the stuck threshold but is the
    legitimate tail of a fan-out, not a blocked one."""
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        run_id = _seed_run(
            scout_id, Scoutrunstatus.COMPLETED, created_at=_ago(45), started_at=_ago(45)
        )
        _seed_ingestion_job(user_id, run_id, Ingestionjobstatus.COMPLETED, created_at=_ago(45))
        requested_at = _ago(40)
        _seed_analysis(user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=requested_at)
        _seed_analysis(
            user_id,
            cv,
            scout_id,
            Analysisstatus.RUNNING_CREW,
            requested_at=_ago(40),
            started_at=_ago(2),
        )

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert _since(scout) == requested_at
        assert scout["blockedAnalysisIds"] == []


def test_a_straggler_from_a_previous_run_still_reads_in_flight(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _seed_run(scout_id, Scoutrunstatus.COMPLETED, created_at=_ago(70), started_at=_ago(70))
        _seed_run(scout_id, Scoutrunstatus.COMPLETED, created_at=_ago(3), started_at=_ago(3))
        requested_at = _ago(65)
        _seed_analysis(user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=requested_at)

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert _since(scout) == requested_at


def test_in_flight_since_is_the_oldest_clock_over_every_branch_that_fired(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        straggler_requested_at = _ago(30)
        _seed_analysis(
            user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=straggler_requested_at
        )
        run_id = _seed_run(
            scout_id, Scoutrunstatus.RUNNING, created_at=_ago(2), started_at=_ago(1)
        )
        _seed_ingestion_job(user_id, run_id, Ingestionjobstatus.PENDING, created_at=_ago(1))

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert _since(scout) == straggler_requested_at


def test_stalled_and_long_queued_analyses_read_blocked(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        # Picked up, then nothing for 30 min: past the 15 min stuck threshold.
        stalled_started_at = _ago(30)
        stalled = _seed_analysis(
            user_id,
            cv,
            scout_id,
            Analysisstatus.RUNNING_CREW,
            requested_at=_ago(50),
            started_at=stalled_started_at,
        )
        # Never picked up for 3 h: past the 120 min queued ceiling.
        queued_requested_at = _ago(180)
        queued = _seed_analysis(
            user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=queued_requested_at
        )

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "BLOCKED"
        assert sorted(scout["blockedAnalysisIds"]) == sorted([stalled, queued])
        assert _since(scout) == queued_requested_at


def test_every_blocked_analysis_is_accepted_by_the_requeue_endpoint(user_id, monkeypatch):
    """The subset invariant, observed where it matters: the panel fans the
    per-Analysis requeue over `blockedAnalysisIds`, and none may come back
    409 ANALYSIS_NOT_STUCK."""
    sent: list[dict] = []
    monkeypatch.setattr(
        "api.v1.make_sqs_client",
        lambda: type("Sqs", (), {"send_message": lambda self, **kw: sent.append(kw)})(),
    )
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        _seed_analysis(
            user_id,
            cv,
            scout_id,
            Analysisstatus.AWAITING_RESULT,
            requested_at=_ago(40),
            started_at=_ago(20),
        )
        _seed_analysis(user_id, cv, scout_id, Analysisstatus.PENDING, requested_at=_ago(150))

        blocked_ids = _scout(client, user_id, scout_id)["blockedAnalysisIds"]
        assert len(blocked_ids) == 2
        for analysis_id in blocked_ids:
            response = client.post(
                f"/v1/analyses/{analysis_id}/requeue", headers=_headers(user_id)
            )
            assert response.status_code == 202, response.text

        # Re-driven rows are queued again, so the Scout is back at work.
        repaired = _scout(client, user_id, scout_id)
        assert repaired["runState"] == "IN_FLIGHT"
        assert repaired["blockedAnalysisIds"] == []
        assert len(sent) == 2


def test_a_requeue_restarts_the_blocked_clock(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        requeued_at = _ago(5)
        _seed_analysis(
            user_id,
            cv,
            scout_id,
            Analysisstatus.QUEUED,
            requested_at=_ago(180),
            requeued_at=requeued_at,
        )

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert scout["blockedAnalysisIds"] == []


def test_fresh_work_outranks_an_older_blocked_analysis(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        _seed_analysis(
            user_id,
            cv,
            scout_id,
            Analysisstatus.RUNNING_CREW,
            requested_at=_ago(50),
            started_at=_ago(30),
        )
        fresh_requested_at = _ago(3)
        _seed_analysis(
            user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=fresh_requested_at
        )

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "IN_FLIGHT"
        assert scout["blockedAnalysisIds"] == []
        assert _since(scout) == fresh_requested_at


def test_a_run_left_running_past_the_stale_threshold_reads_failed(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _seed_run(scout_id, Scoutrunstatus.RUNNING, created_at=_ago(31), started_at=_ago(30))

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "FAILED"
        assert scout["runStateSince"] is None
        assert scout["blockedAnalysisIds"] == []


def test_a_failed_run_reads_failed(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id, status=Scoutrunstatus.FAILED)

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "FAILED"
        assert scout["runStateSince"] is None


def test_a_partially_completed_run_reads_degraded(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id, status=Scoutrunstatus.PARTIALLY_COMPLETED)

        scout = _scout(client, user_id, scout_id)
        assert scout["runState"] == "DEGRADED"
        assert scout["runStateSince"] is None


def test_a_run_reporting_failed_offers_reads_degraded(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id, failed_count=2)

        assert _scout(client, user_id, scout_id)["runState"] == "DEGRADED"


def test_only_the_latest_run_carries_the_verdict(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _seed_run(scout_id, Scoutrunstatus.FAILED, created_at=_ago(1500), started_at=_ago(1500))
        _finished_run(scout_id)

        assert _scout(client, user_id, scout_id)["runState"] == "OK"


def test_a_working_scout_says_so_even_after_a_failed_run(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id, status=Scoutrunstatus.FAILED)
        _seed_analysis(user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=_ago(10))

        assert _scout(client, user_id, scout_id)["runState"] == "IN_FLIGHT"


# --- Isolation, the list, and the other responses ---------------------------


def test_another_users_rows_never_contribute(user_id):
    """The state is reached by the denormalised `Analysis.scoutId`; a row
    carrying this Scout's id under another user's account must not count."""
    other = asyncio.run(_create_user())
    try:
        with TestClient(app) as client:
            cv = _make_cv_version(client, user_id)
            other_cv = _make_cv_version(client, other)
            scout_id = _make_scout(client, user_id, cv)
            run_id = _finished_run(scout_id)
            _seed_analysis(other, other_cv, scout_id, Analysisstatus.QUEUED, requested_at=_ago(5))
            _seed_analysis(
                other, other_cv, scout_id, Analysisstatus.QUEUED, requested_at=_ago(300)
            )
            _seed_ingestion_job(other, run_id, Ingestionjobstatus.RUNNING, created_at=_ago(5))

            scout = _scout(client, user_id, scout_id)
            assert scout["runState"] == "OK"
            assert scout["blockedAnalysisIds"] == []

            # And the other user cannot read this Scout's state at all.
            response = client.get(f"/v1/scouts/{scout_id}", headers=_headers(other))
            assert response.status_code == 404
    finally:
        asyncio.run(_delete_user(other))


def test_the_list_returns_every_state_correctly_in_one_request(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        expected: dict[str, str] = {}

        never = _make_scout(client, user_id, cv, paused=True)
        expected[never] = "NEVER_RUN"

        ok = _make_scout(client, user_id, cv, paused=True)
        _finished_run(ok)
        expected[ok] = "OK"

        in_flight = _make_scout(client, user_id, cv, paused=True)
        _finished_run(in_flight)
        _seed_analysis(user_id, cv, in_flight, Analysisstatus.QUEUED, requested_at=_ago(5))
        expected[in_flight] = "IN_FLIGHT"

        blocked = _make_scout(client, user_id, cv, paused=True)
        _finished_run(blocked)
        blocked_analysis = _seed_analysis(
            user_id, cv, blocked, Analysisstatus.QUEUED, requested_at=_ago(200)
        )
        expected[blocked] = "BLOCKED"

        failed = _make_scout(client, user_id, cv, paused=True)
        _seed_run(failed, Scoutrunstatus.RUNNING, created_at=_ago(40), started_at=_ago(40))
        expected[failed] = "FAILED"

        degraded = _make_scout(client, user_id, cv, paused=True)
        _finished_run(degraded, status=Scoutrunstatus.PARTIALLY_COMPLETED)
        expected[degraded] = "DEGRADED"

        response = client.get("/v1/scouts", headers=_headers(user_id))
        assert response.status_code == 200
        scouts = {s["id"]: s for s in response.json()["scouts"]}

        assert {sid: s["runState"] for sid, s in scouts.items()} == expected
        assert scouts[blocked]["blockedAnalysisIds"] == [blocked_analysis]
        for sid, scout in scouts.items():
            if sid != blocked:
                assert scout["blockedAnalysisIds"] == []
            if scout["runState"] not in ("IN_FLIGHT", "BLOCKED"):
                assert scout["runStateSince"] is None


def test_the_patch_response_carries_the_run_state(user_id):
    with TestClient(app) as client:
        cv = _make_cv_version(client, user_id)
        scout_id = _make_scout(client, user_id, cv)
        _finished_run(scout_id)
        _seed_analysis(user_id, cv, scout_id, Analysisstatus.QUEUED, requested_at=_ago(5))

        response = client.patch(
            f"/v1/scouts/{scout_id}", headers=_headers(user_id), json={"status": "PAUSED"}
        )
        assert response.status_code == 200
        scout = response.json()["scout"]
        # Paused, and still working: both facts, side by side.
        assert scout["status"] == "PAUSED"
        assert scout["runState"] == "IN_FLIGHT"
