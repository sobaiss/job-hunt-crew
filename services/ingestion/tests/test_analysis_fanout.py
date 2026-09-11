import json
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
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    Scout,
    ScoutRun,
    Scoutrunstatus,
    Scoutstatus,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.analysis_fanout import create_analyses_for_ready_offers
from ingestion.sqs_client import ANALYSIS_INTAKE_QUEUE_URL


class FakeSqs:
    def __init__(self):
        self.messages = []

    def send_message(self, *, QueueUrl, MessageBody):
        self.messages.append((QueueUrl, json.loads(MessageBody)))


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


async def _seed(session_factory, *, offer_statuses, with_cv_version=True, analyses_today=0):
    user_id = f"test-user-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}" if with_cv_version else None
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    offer_ids: list[str] = []
    all_offer_ids: list[str] = []

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        if cv_version_id:
            session.add(
                CVVersion(
                    id=cv_version_id,
                    userId=user_id,
                    label="CV",
                    fileKey="cv/x.pdf",
                    fileName="x.pdf",
                    fileType=Cvfiletype.PDF,
                    fileSizeBytes=1234,
                    conversionStatus=Cvconversionstatus.CONVERTED,
                    markdownContent="# CV",
                    updatedAt=_now(),
                )
            )
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.SINGLE_URL,
                cvVersionId=cv_version_id,
                inputUrl="https://jobs.example.com/x",
                maxOffers=25,
                status=Ingestionjobstatus.COMPLETED,
                updatedAt=_now(),
            )
        )
        for status in offer_statuses:
            offer_id = str(uuid.uuid4())
            offer_ids.append(offer_id)
            all_offer_ids.append(offer_id)
            session.add(
                JobOffer(
                    id=offer_id,
                    sourceUrl=f"https://jobs.example.com/offer/{offer_id}",
                    sourceSite=Joboffersourcesite.OTHER,
                    extractionStatus=status,
                    updatedAt=_now(),
                )
            )
            session.add(
                IngestionJobOffer(
                    id=str(uuid.uuid4()),
                    ingestionJobId=ingestion_job_id,
                    jobOfferId=offer_id,
                )
            )
        for _ in range(analyses_today):
            filler_offer_id = str(uuid.uuid4())
            all_offer_ids.append(filler_offer_id)
            session.add(
                JobOffer(
                    id=filler_offer_id,
                    sourceUrl=f"https://jobs.example.com/filler/{filler_offer_id}",
                    sourceSite=Joboffersourcesite.OTHER,
                    extractionStatus=Jobofferextractionstatus.READY,
                    updatedAt=_now(),
                )
            )
            session.add(
                Analysis(
                    id=str(uuid.uuid4()),
                    userId=user_id,
                    jobOfferId=filler_offer_id,
                    cvVersionId=cv_version_id,
                    status=Analysisstatus.PENDING,
                )
            )
        await session.commit()

    return user_id, cv_version_id, ingestion_job_id, offer_ids, all_offer_ids


async def _cleanup(session_factory, *, user_id, ingestion_job_id, all_offer_ids):
    # Delete in dependency order rather than lean on DB cascade — the ORM
    # otherwise tries to NULL out IngestionJob.userId when the User goes.
    async with session_factory() as session:
        for row in (
            await session.scalars(select(Analysis).where(Analysis.userId == user_id))
        ).all():
            await session.delete(row)
        for row in (
            await session.scalars(
                select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
            )
        ).all():
            await session.delete(row)
        await session.commit()

        job = await session.get(IngestionJob, ingestion_job_id)
        if job is not None:
            await session.delete(job)
        for offer_id in all_offer_ids:
            offer = await session.get(JobOffer, offer_id)
            if offer is not None:
                await session.delete(offer)
        await session.commit()

        for row in (
            await session.scalars(select(CVVersion).where(CVVersion.userId == user_id))
        ).all():
            await session.delete(row)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


@pytest.mark.asyncio
async def test_creates_one_analysis_per_ready_offer_and_enqueues():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_version_id, ingestion_job_id, offer_ids, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY, Jobofferextractionstatus.READY],
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert len(result.created_analysis_ids) == 2
        assert result.quota_skipped_count == 0

        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert len(rows) == 2
        assert {r.jobOfferId for r in rows} == set(offer_ids)
        for row in rows:
            assert row.userId == user_id
            assert row.cvVersionId == cv_version_id
            assert row.status == Analysisstatus.PENDING

        async with session_factory() as session:
            job = await session.get(IngestionJob, ingestion_job_id)
        assert job.quotaSkippedCount == 0

        assert sorted(m[1]["analysisId"] for m in fake_sqs.messages) == sorted(
            result.created_analysis_ids
        )
        assert all(m[0] == ANALYSIS_INTAKE_QUEUE_URL for m in fake_sqs.messages)
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


@pytest.mark.asyncio
async def test_skips_non_ready_offers():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, _, ingestion_job_id, offer_ids, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[
            Jobofferextractionstatus.READY,
            Jobofferextractionstatus.FAILED,
            Jobofferextractionstatus.PENDING,
        ],
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert len(result.created_analysis_ids) == 1
        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert [r.jobOfferId for r in rows] == [offer_ids[0]]
        assert len(fake_sqs.messages) == 1
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


@pytest.mark.asyncio
async def test_idempotent_on_second_call():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, _, ingestion_job_id, _, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY, Jobofferextractionstatus.READY],
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            first = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            second = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert len(first.created_analysis_ids) == 2
        assert second.created_analysis_ids == []
        assert second.quota_skipped_count == 0
        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert len(rows) == 2
        assert len(fake_sqs.messages) == 2
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


@pytest.mark.asyncio
async def test_quota_cap_limits_creation_and_records_skip(monkeypatch):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "1")
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, _, ingestion_job_id, _, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY, Jobofferextractionstatus.READY],
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert len(result.created_analysis_ids) == 1
        assert result.quota_skipped_count == 1
        assert len(fake_sqs.messages) == 1

        async with session_factory() as session:
            job = await session.get(IngestionJob, ingestion_job_id)
        # Recorded on the dedicated column, not as prose on errorMessage.
        assert job.quotaSkippedCount == 1
        assert job.errorMessage is None
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


@pytest.mark.asyncio
async def test_owner_already_at_cap_creates_none(monkeypatch):
    monkeypatch.setenv("DAILY_ANALYSIS_CAP", "1")
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, _, ingestion_job_id, _, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY],
        analyses_today=1,
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert result.created_analysis_ids == []
        assert result.quota_skipped_count == 1
        assert fake_sqs.messages == []
        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
            job = await session.get(IngestionJob, ingestion_job_id)
        assert rows == []
        assert job.quotaSkippedCount == 1
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


@pytest.mark.asyncio
async def test_no_cv_version_is_noop():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, _, ingestion_job_id, _, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY],
        with_cv_version=False,
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert result.created_analysis_ids == []
        assert result.quota_skipped_count == 0
        assert fake_sqs.messages == []
        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert rows == []
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


async def _attach_scout_run(session_factory, *, user_id, cv_version_id, ingestion_job_id):
    """Create a Scout + ScoutRun owned by `user_id` and stamp the run id onto
    `ingestion_job_id.scoutRunId` — mirrors what `dispatch_scout_run` does when
    it fans a Scout run out to `ingestion-intake`."""
    scout_id = f"test-scout-{uuid.uuid4()}"
    scout_run_id = f"test-scout-run-{uuid.uuid4()}"
    async with session_factory() as session:
        session.add(
            Scout(
                id=scout_id,
                userId=user_id,
                label="Backend — Remote",
                cvVersionId=cv_version_id,
                targetSiteKeys=["FRANCE_TRAVAIL"],
                filters={},
                matchThreshold=70,
                status=Scoutstatus.ACTIVE,
                updatedAt=_now(),
            )
        )
        session.add(
            ScoutRun(
                id=scout_run_id,
                scoutId=scout_id,
                status=Scoutrunstatus.RUNNING,
            )
        )
        job = await session.get(IngestionJob, ingestion_job_id)
        job.scoutRunId = scout_run_id
        await session.commit()
    return scout_id, scout_run_id


async def _cleanup_scout(session_factory, *, scout_id, scout_run_id, ingestion_job_id):
    # Drop the FK from the job to the run first, then the run, then the Scout —
    # the CVVersion the Scout points at (onDelete: Restrict) is removed by
    # `_cleanup`, which must run *after* this.
    async with session_factory() as session:
        job = await session.get(IngestionJob, ingestion_job_id)
        if job is not None:
            job.scoutRunId = None
        await session.commit()

        run = await session.get(ScoutRun, scout_run_id)
        if run is not None:
            await session.delete(run)
        scout = await session.get(Scout, scout_id)
        if scout is not None:
            await session.delete(scout)
        await session.commit()


@pytest.mark.asyncio
async def test_tags_analyses_with_scout_id_for_a_scout_run():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, cv_version_id, ingestion_job_id, offer_ids, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY, Jobofferextractionstatus.READY],
    )
    scout_id, scout_run_id = await _attach_scout_run(
        session_factory,
        user_id=user_id,
        cv_version_id=cv_version_id,
        ingestion_job_id=ingestion_job_id,
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await create_analyses_for_ready_offers(
                session, ingestion_job, sqs_client=fake_sqs
            )

        assert len(result.created_analysis_ids) == 2
        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert {r.scoutId for r in rows} == {scout_id}
    finally:
        await _cleanup_scout(
            session_factory,
            scout_id=scout_id,
            scout_run_id=scout_run_id,
            ingestion_job_id=ingestion_job_id,
        )
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()


@pytest.mark.asyncio
async def test_manual_job_leaves_scout_id_null():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, _, ingestion_job_id, _, all_offer_ids = await _seed(
        session_factory,
        offer_statuses=[Jobofferextractionstatus.READY],
    )
    fake_sqs = FakeSqs()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            await create_analyses_for_ready_offers(session, ingestion_job, sqs_client=fake_sqs)

        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert [r.scoutId for r in rows] == [None]
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, all_offer_ids=all_offer_ids)
        await engine.dispose()
