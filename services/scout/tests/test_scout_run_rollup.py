"""Progressive roll-up of a `ScoutRun`'s per-offer counts (issue #54).

`dispatch_scout_run` sets a run's site-level columns when it fans out; the
per-offer columns (`offersDiscovered` / `offersAnalysed` / `relevantCount` /
`failedCount`) can only be known once the ingestion + analysis pipelines the
run kicked off have progressed. `py_db.scout_rollup.roll_up_scout_run`
recomputes them from the run's `IngestionJob`s and their `Analysis` rows; the
ingestion fan-out and each terminal `Analysis` transition call it.
"""

import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvconversionstatus,
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
from py_db.scout_rollup import roll_up_scout_run, roll_up_scout_run_for_analysis
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _seed(session_factory, *, jobs, match_threshold=70):
    """Seed a Scout + a RUNNING ScoutRun + one IngestionJob per entry in
    `jobs`. Each entry is a dict:
      {"discovered": int, "failed": int, "analyses": [(status, matchScore), ...]}
    Returns (user_id, scout_id, scout_run_id, [analysis_id, ...]).
    """
    user_id = f"rollup-user-{uuid.uuid4()}"
    cv_id = f"rollup-cv-{uuid.uuid4()}"
    scout_id = f"rollup-scout-{uuid.uuid4()}"
    run_id = f"rollup-run-{uuid.uuid4()}"
    analysis_ids: list[str] = []
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
                conversionStatus=Cvconversionstatus.CONVERTED,
                markdownContent="# CV",
                updatedAt=_now(),
            )
        )
        session.add(
            Scout(
                id=scout_id,
                userId=user_id,
                label="Rollup Scout",
                cvVersionId=cv_id,
                targetSiteKeys=["FRANCE_TRAVAIL"],
                filters={},
                matchThreshold=match_threshold,
                status=Scoutstatus.ACTIVE,
                updatedAt=_now(),
            )
        )
        session.add(ScoutRun(id=run_id, scoutId=scout_id, status=Scoutrunstatus.RUNNING))
        for spec in jobs:
            job_id = f"rollup-job-{uuid.uuid4()}"
            session.add(
                IngestionJob(
                    id=job_id,
                    userId=user_id,
                    mode=Ingestionmode.SITE_SEARCH,
                    cvVersionId=cv_id,
                    scoutRunId=run_id,
                    discoveredCount=spec.get("discovered", 0),
                    failedCount=spec.get("failed", 0),
                    status=Ingestionjobstatus.COMPLETED,
                    updatedAt=_now(),
                )
            )
            for status, match_score in spec.get("analyses", []):
                offer_id = f"rollup-offer-{uuid.uuid4()}"
                session.add(
                    JobOffer(
                        id=offer_id,
                        sourceUrl=f"https://example.test/{offer_id}",
                        sourceSite=Joboffersourcesite.OTHER,
                        updatedAt=_now(),
                    )
                )
                analysis_id = f"rollup-analysis-{uuid.uuid4()}"
                analysis_ids.append(analysis_id)
                session.add(
                    Analysis(
                        id=analysis_id,
                        userId=user_id,
                        jobOfferId=offer_id,
                        cvVersionId=cv_id,
                        ingestionJobId=job_id,
                        scoutId=scout_id,
                        status=status,
                        matchScore=match_score,
                    )
                )
        await session.commit()
    return user_id, scout_id, run_id, analysis_ids


async def _cleanup(session_factory, *, user_id, scout_id):
    async with session_factory() as session:
        runs = (await session.scalars(select(ScoutRun).where(ScoutRun.scoutId == scout_id))).all()
        for run in runs:
            jobs = (
                await session.scalars(
                    select(IngestionJob).where(IngestionJob.scoutRunId == run.id)
                )
            ).all()
            for job in jobs:
                for analysis in (
                    await session.scalars(
                        select(Analysis).where(Analysis.ingestionJobId == job.id)
                    )
                ).all():
                    offer_id = analysis.jobOfferId
                    await session.delete(analysis)
                    await session.flush()
                    offer = await session.get(JobOffer, offer_id)
                    if offer is not None:
                        await session.delete(offer)
                await session.delete(job)
            await session.commit()
        for run in runs:
            await session.delete(await session.get(ScoutRun, run.id))
        scout = await session.get(Scout, scout_id)
        if scout is not None:
            await session.delete(scout)
        await session.commit()
        for cv in (
            await session.scalars(select(CVVersion).where(CVVersion.userId == user_id))
        ).all():
            await session.delete(cv)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


async def _run(session_factory, run_id):
    async with session_factory() as session:
        return await session.get(ScoutRun, run_id)


@pytest.mark.asyncio
async def test_rolls_up_discovered_analysed_relevant_and_failed_across_jobs():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, scout_id, run_id, _ = await _seed(
        session_factory,
        match_threshold=70,
        jobs=[
            {
                "discovered": 3,
                "failed": 1,
                "analyses": [
                    (Analysisstatus.COMPLETED, 82),  # relevant
                    (Analysisstatus.COMPLETED, 55),  # analysed, not relevant
                ],
            },
            {
                "discovered": 2,
                "failed": 0,
                "analyses": [
                    (Analysisstatus.COMPLETED, 70),  # relevant (>= threshold)
                    (Analysisstatus.FAILED, None),  # failed analysis
                    (Analysisstatus.PENDING, None),  # still running — not counted
                ],
            },
        ],
    )
    try:
        async with session_factory() as session:
            await roll_up_scout_run(session, run_id)

        run = await _run(session_factory, run_id)
        assert run.offersDiscovered == 5
        assert run.offersAnalysed == 3
        assert run.relevantCount == 2
        assert run.failedCount == 2  # 1 ingestion failure + 1 failed analysis
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_missing_run_is_a_noop():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            await roll_up_scout_run(session, f"does-not-exist-{uuid.uuid4()}")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_with_no_ingestion_jobs_stays_zero():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, scout_id, run_id, _ = await _seed(session_factory, jobs=[])
    try:
        async with session_factory() as session:
            await roll_up_scout_run(session, run_id)

        run = await _run(session_factory, run_id)
        assert (run.offersDiscovered, run.offersAnalysed, run.relevantCount, run.failedCount) == (
            0,
            0,
            0,
            0,
        )
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_for_analysis_resolves_the_owning_run():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, scout_id, run_id, analysis_ids = await _seed(
        session_factory,
        match_threshold=60,
        jobs=[{"discovered": 1, "analyses": [(Analysisstatus.COMPLETED, 65)]}],
    )
    try:
        async with session_factory() as session:
            await roll_up_scout_run_for_analysis(session, analysis_ids[0])

        run = await _run(session_factory, run_id)
        assert run.offersDiscovered == 1
        assert run.offersAnalysed == 1
        assert run.relevantCount == 1
    finally:
        await _cleanup(session_factory, user_id=user_id, scout_id=scout_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_for_analysis_is_a_noop_for_a_manual_analysis():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"rollup-manual-user-{uuid.uuid4()}"
    cv_id = f"rollup-manual-cv-{uuid.uuid4()}"
    offer_id = f"rollup-manual-offer-{uuid.uuid4()}"
    analysis_id = f"rollup-manual-analysis-{uuid.uuid4()}"
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
                conversionStatus=Cvconversionstatus.CONVERTED,
                markdownContent="# CV",
                updatedAt=_now(),
            )
        )
        session.add(
            JobOffer(
                id=offer_id,
                sourceUrl=f"https://example.test/{offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                updatedAt=_now(),
            )
        )
        session.add(
            Analysis(
                id=analysis_id,
                userId=user_id,
                jobOfferId=offer_id,
                cvVersionId=cv_id,
                status=Analysisstatus.COMPLETED,
                matchScore=90,
            )
        )
        await session.commit()
    try:
        async with session_factory() as session:
            await roll_up_scout_run_for_analysis(session, analysis_id)  # must not raise
    finally:
        async with session_factory() as session:
            await session.delete(await session.get(Analysis, analysis_id))
            await session.flush()
            await session.delete(await session.get(JobOffer, offer_id))
            await session.delete(await session.get(CVVersion, cv_id))
            await session.delete(await session.get(User, user_id))
            await session.commit()
        await engine.dispose()
