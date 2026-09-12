"""Cost-bounded Scout matching (issue #55): the per-run analysis ceiling and
the no-LLM lexical pre-rank (`py_db.scout_matching`). The integration with the
ingestion fan-out — dedup, ranking, and the ceiling actually gating creation —
is covered by `services/ingestion/tests/test_analysis_fanout.py`; this file
pins the shared helpers themselves, mirroring `test_daily_quota_helper.py`.
"""

import uuid
from datetime import UTC, datetime

import pytest
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
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    User,
)
from py_db.scout_matching import (
    DEFAULT_SCOUT_MAX_ANALYSES_PER_RUN,
    analyses_created_for_scout_run,
    lexical_similarity,
    scout_max_analyses_per_run,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def test_limit_defaults_to_20_when_unset(monkeypatch):
    monkeypatch.delenv("SCOUT_MAX_ANALYSES_PER_RUN", raising=False)
    assert scout_max_analyses_per_run() == DEFAULT_SCOUT_MAX_ANALYSES_PER_RUN == 20


def test_limit_reads_a_valid_positive_int(monkeypatch):
    monkeypatch.setenv("SCOUT_MAX_ANALYSES_PER_RUN", "5")
    assert scout_max_analyses_per_run() == 5


@pytest.mark.parametrize("bad", ["", "nope", "0", "-3", "3.5"])
def test_limit_falls_back_on_non_positive_or_non_numeric(monkeypatch, bad):
    monkeypatch.setenv("SCOUT_MAX_ANALYSES_PER_RUN", bad)
    assert scout_max_analyses_per_run() == DEFAULT_SCOUT_MAX_ANALYSES_PER_RUN


def test_similarity_of_identical_text_is_one():
    assert lexical_similarity("Senior Python Backend Engineer", "Senior Python Backend Engineer") == 1.0


def test_similarity_of_disjoint_text_is_zero():
    assert lexical_similarity("Python Django AWS", "Recipes for chocolate cake") == 0.0


def test_similarity_is_partial_for_overlapping_text():
    score = lexical_similarity("Python Django AWS Kubernetes", "Python AWS terraform")
    assert 0.0 < score < 1.0


@pytest.mark.parametrize("empty", ["", None])
def test_similarity_with_empty_text_is_zero(empty):
    assert lexical_similarity(empty, "Python AWS") == 0.0
    assert lexical_similarity("Python AWS", empty) == 0.0


@pytest.mark.asyncio
async def test_analyses_created_for_scout_run_counts_across_jobs():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"matching-user-{uuid.uuid4()}"
    cv_id = f"matching-cv-{uuid.uuid4()}"
    scout_id = f"matching-scout-{uuid.uuid4()}"
    run_id = f"matching-run-{uuid.uuid4()}"
    other_run_id = f"matching-other-run-{uuid.uuid4()}"
    job_ids: list[str] = []
    offer_ids: list[str] = []
    analysis_ids: list[str] = []

    try:
        async with session_factory() as session:
            session.add(User(id=user_id, updatedAt=_now()))
            session.add(
                CVVersion(
                    id=cv_id,
                    userId=user_id,
                    label="CV",
                    fileKey="cv/x.pdf",
                    fileName="x.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=10,
                    updatedAt=_now(),
                )
            )
            session.add(
                Scout(
                    id=scout_id,
                    userId=user_id,
                    label="Matching Scout",
                    cvVersionId=cv_id,
                    targetSiteKeys=["FRANCE_TRAVAIL"],
                    filters={},
                    matchThreshold=70,
                    status=Scoutstatus.ACTIVE,
                    updatedAt=_now(),
                )
            )
            session.add(ScoutRun(id=run_id, scoutId=scout_id, status=Scoutrunstatus.RUNNING))
            session.add(ScoutRun(id=other_run_id, scoutId=scout_id, status=Scoutrunstatus.RUNNING))
            # Two IngestionJobs on the run under test, one on another run.
            for run in (run_id, run_id, other_run_id):
                job_id = f"matching-job-{uuid.uuid4()}"
                job_ids.append(job_id)
                session.add(
                    IngestionJob(
                        id=job_id,
                        userId=user_id,
                        mode=Ingestionmode.SITE_SEARCH,
                        cvVersionId=cv_id,
                        scoutRunId=run,
                        status=Ingestionjobstatus.COMPLETED,
                        updatedAt=_now(),
                    )
                )
            await session.flush()
            # Two Analysis rows against the run-under-test's jobs, one against
            # the other run's job — only the first two should count.
            for job_id in job_ids:
                offer_id = f"matching-offer-{uuid.uuid4()}"
                offer_ids.append(offer_id)
                session.add(
                    JobOffer(
                        id=offer_id,
                        sourceUrl=f"https://example.test/{offer_id}",
                        sourceSite=Joboffersourcesite.OTHER,
                        updatedAt=_now(),
                    )
                )
                analysis_id = f"matching-analysis-{uuid.uuid4()}"
                analysis_ids.append(analysis_id)
                session.add(
                    Analysis(
                        id=analysis_id,
                        userId=user_id,
                        jobOfferId=offer_id,
                        cvVersionId=cv_id,
                        ingestionJobId=job_id,
                        scoutId=scout_id,
                        status=Analysisstatus.PENDING,
                    )
                )
            await session.commit()

        async with session_factory() as session:
            assert await analyses_created_for_scout_run(session, run_id) == 2
            assert await analyses_created_for_scout_run(session, other_run_id) == 1
            assert await analyses_created_for_scout_run(session, f"no-such-run-{uuid.uuid4()}") == 0
    finally:
        async with session_factory() as session:
            for analysis_id in analysis_ids:
                row = await session.get(Analysis, analysis_id)
                if row is not None:
                    await session.delete(row)
            await session.commit()
            for job_id in job_ids:
                job = await session.get(IngestionJob, job_id)
                if job is not None:
                    await session.delete(job)
            for offer_id in offer_ids:
                offer = await session.get(JobOffer, offer_id)
                if offer is not None:
                    await session.delete(offer)
            await session.commit()
            for run_row in (
                await session.scalars(select(ScoutRun).where(ScoutRun.scoutId == scout_id))
            ).all():
                await session.delete(run_row)
            scout = await session.get(Scout, scout_id)
            if scout is not None:
                await session.delete(scout)
            await session.commit()
            cv = await session.get(CVVersion, cv_id)
            if cv is not None:
                await session.delete(cv)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()
