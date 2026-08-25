import uuid
from datetime import UTC, datetime

import boto3
import pytest
import respx
from botocore.client import Config
from httpx import Response
from py_db.models import JobOffer, Jobofferextractionstatus, Joboffersourcesite
from py_db.session import make_engine, make_session_factory

from ingestion.s3_client import S3_BUCKET, raw_scrape_key
from ingestion.scrape import scrape_job_offer

FIXTURE_URL = "https://example.com/jobs/fixture-123"
FIXTURE_HTML = "<html><body><h1>Senior Backend Engineer</h1></body></html>"


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )


@pytest.mark.asyncio
async def test_scrape_job_offer_stores_html_and_transitions_status():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    s3 = _s3_client()

    async with session_factory() as session:
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=FIXTURE_URL,
                sourceSite=Joboffersourcesite.OTHER,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()

    try:
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            assert job_offer.extractionStatus == Jobofferextractionstatus.PENDING

            observed = {}

            async def fetch_side_effect(request):
                async with session_factory() as probe_session:
                    probe = await probe_session.get(JobOffer, job_offer_id)
                    observed["status_during_fetch"] = probe.extractionStatus
                return Response(200, text=FIXTURE_HTML)

            with respx.mock(assert_all_called=True) as mock:
                mock.get(FIXTURE_URL).mock(side_effect=fetch_side_effect)
                await scrape_job_offer(session, job_offer_id)

            assert observed["status_during_fetch"] == Jobofferextractionstatus.SCRAPING

        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            assert job_offer.extractionStatus == Jobofferextractionstatus.SCRAPED
            assert job_offer.rawContentKey == raw_scrape_key(job_offer_id)

        obj = s3.get_object(Bucket=S3_BUCKET, Key=raw_scrape_key(job_offer_id))
        assert obj["Body"].read().decode("utf-8") == FIXTURE_HTML
    finally:
        try:
            s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(job_offer_id))
        except Exception:
            pass
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_scrape_job_offer_marks_failed_on_fetch_error():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    job_offer_id = f"test-{uuid.uuid4()}"
    unreachable_url = "https://example.com/jobs/unreachable-456"

    async with session_factory() as session:
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=unreachable_url,
                sourceSite=Joboffersourcesite.OTHER,
                updatedAt=datetime.now(UTC).replace(tzinfo=None),
            )
        )
        await session.commit()

    try:
        async with session_factory() as session:
            with respx.mock(assert_all_called=True) as mock:
                mock.get(unreachable_url).mock(return_value=Response(404))
                with pytest.raises(Exception):
                    await scrape_job_offer(session, job_offer_id)

        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            assert job_offer.extractionStatus == Jobofferextractionstatus.FAILED
            assert job_offer.errorMessage
    finally:
        async with session_factory() as session:
            job_offer = await session.get(JobOffer, job_offer_id)
            if job_offer is not None:
                await session.delete(job_offer)
                await session.commit()
        await engine.dispose()
