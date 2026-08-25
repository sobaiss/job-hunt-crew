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
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.france_travail import TOKEN_URL
from ingestion.s3_client import S3_BUCKET, raw_scrape_key
from ingestion.site_search_pipeline import run_site_search_ingestion

FIXTURE_OFFER_HTML = "<html><body><h1>Senior Backend Engineer</h1></body></html>"
VALID_LLM_OUTPUT = (
    '{"description": "Senior Backend Engineer role.", "requirements": ["5+ years Python"], '
    '"salary": null, "contractType": "full_time", "remotePolicy": "remote", "seniority": "senior"}'
)


class StubLLMProvider(LLMProvider):
    def __init__(self, response=VALID_LLM_OUTPUT):
        self._response = response

    def generate(self, *, system: str, prompt: str) -> str:
        return self._response


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )

LINKEDIN_LISTING_URL = "https://www.linkedin.com/jobs/search?keywords=python"

# 5 cards matching the LinkedIn selectors seeded in packages/prisma/prisma/seed.js
# (mirrored the same way as test_site_adapters.py's fixtures).
LINKEDIN_LISTING_HTML = """
<html><body>
<ul class="jobs-search__results-list">
{}
</ul>
</body></html>
""".format(
    "\n".join(
        f'<li><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/{i}">Job {i}</a></li>'
        for i in range(5)
    )
)

# A blocked/CAPTCHA-style response: valid HTML but with none of the expected
# job-card structure, so the adapter discovers zero offers.
LINKEDIN_BLOCKED_HTML = "<html><body><h1>Verify you're human</h1></body></html>"


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


def _linkedin_site_config() -> SiteConfig:
    return SiteConfig(
        id="site-linkedin",
        siteKey=Siteconfigsitekey.LINKEDIN,
        displayName="LinkedIn",
        baseUrl="https://www.linkedin.com",
        searchUrlTemplate="https://www.linkedin.com/jobs/search?keywords={keywords}",
        filterParamMapping={"keywords": "keywords"},
        listItemSelector="ul.jobs-search__results-list > li",
        offerLinkSelector="a.base-card__full-link",
        offerTitleSelector="h3.base-search-card__title",
        integrationType=Siteconfigintegrationtype.HTML_SCRAPE,
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.HIGH,
        enabled=True,
    )


def _france_travail_site_config() -> SiteConfig:
    return SiteConfig(
        id="site-france-travail",
        siteKey=Siteconfigsitekey.FRANCE_TRAVAIL,
        displayName="France Travail",
        baseUrl="https://www.francetravail.fr",
        filterParamMapping={"keywords": "motsCles"},
        integrationType=Siteconfigintegrationtype.OFFICIAL_API,
        apiBaseUrl="https://api.francetravail.io/partenaire/offresdemploi/v2",
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.LOW,
        enabled=True,
    )


async def _seed_ingestion_job(session_factory, *, mode=Ingestionmode.SITE_SEARCH, site_config_id):
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=mode,
                siteConfigId=site_config_id,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=_now(),
            )
        )
        await session.commit()
    return user_id, ingestion_job_id


async def _cleanup(session_factory, *, user_id, ingestion_job_id, source_urls=()):
    async with session_factory() as session:
        links = (
            await session.scalars(
                select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
            )
        ).all()
        for link in links:
            await session.delete(link)
        await session.commit()

        if source_urls:
            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(source_urls)))).all()
            for offer in offers:
                await session.delete(offer)

        # PipelineEvent.ingestionJobId (M6-T3) has ON DELETE CASCADE at the
        # DB level, but SQLAlchemy's default relationship handling nulls
        # rather than deletes orphaned children when the parent is removed
        # via the ORM — so delete these explicitly first, rather than
        # relying on the DB-level cascade.
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
async def test_run_site_search_ingestion_html_scrape_success_produces_ready_offers():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    site_config = _linkedin_site_config()
    user_id, ingestion_job_id = await _seed_ingestion_job(session_factory, site_config_id=site_config.id)
    source_urls = [f"https://www.linkedin.com/jobs/view/{i}" for i in range(5)]
    s3 = _s3_client()

    try:
        with respx.mock:
            respx.mock.get(LINKEDIN_LISTING_URL).mock(return_value=Response(200, text=LINKEDIN_LISTING_HTML))
            for url in source_urls:
                respx.mock.get(url).mock(return_value=Response(200, text=FIXTURE_OFFER_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_site_search_ingestion(
                    session, ingestion_job, site_config, {"keywords": "python"}, llm_provider=StubLLMProvider()
                )

        assert result.status == Ingestionjobstatus.COMPLETED
        assert result.discoveredCount == 5
        assert result.errorMessage is None
    finally:
        async with session_factory() as session:
            offers = (await session.scalars(select(JobOffer).where(JobOffer.sourceUrl.in_(source_urls)))).all()
            for offer in offers:
                try:
                    s3.delete_object(Bucket=S3_BUCKET, Key=raw_scrape_key(offer.id))
                except Exception:
                    pass
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, source_urls=source_urls)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_site_search_ingestion_html_scrape_listing_fetch_failure_sets_failed_with_error_message():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    site_config = _linkedin_site_config()
    user_id, ingestion_job_id = await _seed_ingestion_job(session_factory, site_config_id=site_config.id)

    try:
        with respx.mock:
            respx.mock.get(LINKEDIN_LISTING_URL).mock(return_value=Response(403))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_site_search_ingestion(
                    session, ingestion_job, site_config, {"keywords": "python"}
                )

        assert result.status == Ingestionjobstatus.FAILED
        assert result.errorMessage
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_site_search_ingestion_html_scrape_zero_offers_discovered_sets_failed_with_error_message():
    """A block/CAPTCHA page (PRD Section 14 anti-bot risk) is a successful
    HTTP fetch that simply doesn't match the site's selectors — this must
    never be reported as a silent zero-result COMPLETED job (PRD 8.5 step 5).
    """
    engine = make_engine()
    session_factory = make_session_factory(engine)
    site_config = _linkedin_site_config()
    user_id, ingestion_job_id = await _seed_ingestion_job(session_factory, site_config_id=site_config.id)

    try:
        with respx.mock:
            respx.mock.get(LINKEDIN_LISTING_URL).mock(return_value=Response(200, text=LINKEDIN_BLOCKED_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_site_search_ingestion(
                    session, ingestion_job, site_config, {"keywords": "python"}
                )

        assert result.status == Ingestionjobstatus.FAILED
        assert result.errorMessage
        assert result.discoveredCount == 0
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_site_search_ingestion_html_scrape_config_error_sets_failed_with_error_message():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    site_config = _linkedin_site_config()
    site_config.listItemSelector = None
    user_id, ingestion_job_id = await _seed_ingestion_job(session_factory, site_config_id=site_config.id)

    try:
        with respx.mock:
            respx.mock.get(LINKEDIN_LISTING_URL).mock(return_value=Response(200, text=LINKEDIN_LISTING_HTML))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_site_search_ingestion(
                    session, ingestion_job, site_config, {"keywords": "python"}
                )

        assert result.status == Ingestionjobstatus.FAILED
        assert result.errorMessage
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_site_search_ingestion_official_api_failure_sets_failed_with_error_message(monkeypatch):
    monkeypatch.delenv("FRANCE_TRAVAIL_CLIENT_ID", raising=False)
    monkeypatch.delenv("FRANCE_TRAVAIL_CLIENT_SECRET", raising=False)

    engine = make_engine()
    session_factory = make_session_factory(engine)
    site_config = _france_travail_site_config()
    user_id, ingestion_job_id = await _seed_ingestion_job(session_factory, site_config_id=site_config.id)

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            result = await run_site_search_ingestion(
                session, ingestion_job, site_config, {"keywords": "python"}
            )

        assert result.status == Ingestionjobstatus.FAILED
        assert result.errorMessage
    finally:
        await _cleanup(session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id)
        await engine.dispose()


@pytest.mark.asyncio
async def test_run_site_search_ingestion_official_api_success_delegates_to_france_travail(monkeypatch):
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_SECRET", "test-client-secret")

    engine = make_engine()
    session_factory = make_session_factory(engine)
    site_config = _france_travail_site_config()
    user_id, ingestion_job_id = await _seed_ingestion_job(session_factory, site_config_id=site_config.id)
    source_url = "https://candidat.francetravail.fr/offres/recherche/detail/123ABCD"

    try:
        with respx.mock:
            respx.mock.post(TOKEN_URL).mock(return_value=Response(200, json={"access_token": "fake-token"}))
            respx.mock.get(
                url__startswith="https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search"
            ).mock(
                return_value=Response(
                    200,
                    json={
                        "resultats": [
                            {
                                "id": "123ABCD",
                                "intitule": "Ingénieur logiciel backend",
                                "entreprise": {"nom": "Acme France"},
                            }
                        ]
                    },
                )
            )

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                result = await run_site_search_ingestion(
                    session, ingestion_job, site_config, {"keywords": "python"}
                )

        assert result.status == Ingestionjobstatus.COMPLETED
        assert result.discoveredCount == 1
        assert result.errorMessage is None
    finally:
        await _cleanup(
            session_factory, user_id=user_id, ingestion_job_id=ingestion_job_id, source_urls=[source_url]
        )
        await engine.dispose()
