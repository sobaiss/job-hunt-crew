import json
import uuid
from datetime import UTC, datetime

import boto3
import pytest
import respx
from analysis.llm_provider import LLMProvider
from botocore.client import Config
from httpx import Response
from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    PipelineEvent,
    Jobofferextractionstatus,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion import intake_handler
from ingestion.intake_handler import IngestionIntakeError, dispatch_ingestion_job
from ingestion.s3_client import S3_BUCKET, raw_scrape_key

VALID_LLM_OUTPUT = json.dumps(
    {
        "description": "Senior Backend Engineer role.",
        "requirements": ["5+ years Python"],
        "salary": None,
        "contractType": "full_time",
        "remotePolicy": "remote",
        "seniority": "senior",
    }
)


class StubLLMProvider(LLMProvider):
    def generate(self, *, system: str, prompt: str) -> str:
        return VALID_LLM_OUTPUT


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


async def _seed_job(session_factory, *, mode, input_url=None, site_config_id=None):
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=mode,
                inputUrl=input_url,
                siteConfigId=site_config_id,
                maxOffers=1,
                status=Ingestionjobstatus.PENDING,
                updatedAt=_now(),
            )
        )
        await session.commit()
    return user_id, ingestion_job_id


async def _cleanup(session_factory, *, user_id, ingestion_job_id, source_urls=()):
    s3 = _s3_client()
    async with session_factory() as session:
        offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(source_urls)))).all()
        for offer in offers:
            try:
                s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(offer.id))
            except Exception:
                pass
        links = (
            await session.scalars(
                select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
            )
        ).all()
        for link in links:
            await session.delete(link)
        await session.commit()
        for offer in offers:
            await session.delete(offer)
        events = (
            await session.scalars(select(PipelineEvent).where(PipelineEvent.ingestionJobId == ingestion_job_id))
        ).all()
        for event in events:
            await session.delete(event)
        job = await session.get(IngestionJob, ingestion_job_id)
        if job is not None:
            await session.delete(job)
        user = await session.get(User, user_id)
        if user is not None:
            await session.delete(user)
        await session.commit()


@pytest.mark.asyncio
async def test_dispatch_ingestion_job_single_url_runs_the_pipeline():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://jobs.example.com/offer/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(
        session_factory, mode=Ingestionmode.SINGLE_URL, input_url=source_url
    )

    try:
        with respx.mock:
            respx.mock.get(source_url).mock(return_value=Response(200, text="<html><body><h1>Role</h1></body></html>"))
            async with session_factory() as session:
                result = await dispatch_ingestion_job(
                    session, ingestion_job_id, llm_provider=StubLLMProvider()
                )

        assert result.status == Ingestionjobstatus.COMPLETED
        assert result.discoveredCount == 1

        async with session_factory() as session:
            offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == source_url))
            assert offer.extractionStatus == Jobofferextractionstatus.READY
    finally:
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_ingestion_job_single_url_creates_analysis_and_enqueues():
    """The shared end-of-fan-out step (issue #27 slice 4): once the SINGLE_URL
    pipeline leaves a linked JobOffer READY, dispatch creates one Analysis
    (userId + cvVersionId carried on the IngestionJob, jobOfferId,
    ingestionJobId) and enqueues {"analysisId": id} on analysis-intake."""
    from py_db.models import Analysis, CVVersion, Cvconversionstatus, Cvfiletype

    class FakeSqs:
        def __init__(self):
            self.messages = []

        def send_message(self, *, QueueUrl, MessageBody):
            self.messages.append((QueueUrl, json.loads(MessageBody)))

    engine = make_engine()
    session_factory = make_session_factory(engine)
    source_url = f"https://jobs.example.com/offer/{uuid.uuid4()}"
    user_id, ingestion_job_id = await _seed_job(
        session_factory, mode=Ingestionmode.SINGLE_URL, input_url=source_url
    )
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    async with session_factory() as session:
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
        job = await session.get(IngestionJob, ingestion_job_id)
        job.cvVersionId = cv_version_id
        await session.commit()

    fake_sqs = FakeSqs()
    try:
        with respx.mock:
            respx.mock.get(source_url).mock(
                return_value=Response(200, text="<html><body><h1>Role</h1></body></html>")
            )
            async with session_factory() as session:
                await dispatch_ingestion_job(
                    session, ingestion_job_id, llm_provider=StubLLMProvider(), sqs_client=fake_sqs
                )

        async with session_factory() as session:
            offer = await session.scalar(select(JobOffer).where(JobOffer.sourceUrl == source_url))
            analyses = (
                await session.scalars(
                    select(Analysis).where(Analysis.ingestionJobId == ingestion_job_id)
                )
            ).all()
        assert len(analyses) == 1
        assert analyses[0].jobOfferId == offer.id
        assert analyses[0].userId == user_id
        assert analyses[0].cvVersionId == cv_version_id
        assert [m[1]["analysisId"] for m in fake_sqs.messages] == [analyses[0].id]
    finally:
        async with session_factory() as session:
            for row in (
                await session.scalars(select(Analysis).where(Analysis.userId == user_id))
            ).all():
                await session.delete(row)
            await session.commit()
            cv = await session.get(CVVersion, cv_version_id)
            if cv is not None:
                await session.delete(cv)
            await session.commit()
        await _cleanup(
            session_factory,
            user_id=user_id,
            ingestion_job_id=ingestion_job_id,
            source_urls=[source_url],
        )
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_ingestion_job_missing_row_raises():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            with pytest.raises(IngestionIntakeError):
                await dispatch_ingestion_job(session, f"missing-{uuid.uuid4()}")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_dispatch_ingestion_job_site_search_without_site_config_raises():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, ingestion_job_id = await _seed_job(
        session_factory, mode=Ingestionmode.SITE_SEARCH, site_config_id=None
    )
    try:
        async with session_factory() as session:
            with pytest.raises(IngestionIntakeError):
                await dispatch_ingestion_job(session, ingestion_job_id)
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id)
        await engine.dispose()


def test_handle_ingestion_intake_unwraps_records_and_dispatches(monkeypatch):
    seen = []

    async def _spy(session, ingestion_job_id, **kwargs):
        seen.append(ingestion_job_id)

    monkeypatch.setattr(intake_handler, "dispatch_ingestion_job", _spy)

    event = {
        "Records": [
            {"body": json.dumps({"ingestionJobId": "job-1"})},
            {"body": json.dumps({"ingestionJobId": "job-2"})},
        ]
    }
    intake_handler.handle_ingestion_intake(event)

    assert seen == ["job-1", "job-2"]


def test_handle_ingestion_intake_swallows_a_per_record_failure(monkeypatch):
    seen = []

    async def _spy(session, ingestion_job_id, **kwargs):
        if ingestion_job_id == "job-bad":
            raise IngestionIntakeError("boom")
        seen.append(ingestion_job_id)

    monkeypatch.setattr(intake_handler, "dispatch_ingestion_job", _spy)

    event = {
        "Records": [
            {"body": json.dumps({"ingestionJobId": "job-bad"})},
            {"body": json.dumps({"ingestionJobId": "job-ok"})},
        ]
    }
    intake_handler.handle_ingestion_intake(event)

    assert seen == ["job-ok"]
