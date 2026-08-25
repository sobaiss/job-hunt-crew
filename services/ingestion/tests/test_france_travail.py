import uuid
from datetime import UTC, datetime

import pytest
import respx
from httpx import Response
from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    Ingestionjobstatus,
    Ingestionmode,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    SiteConfig,
    Siteconfigantibotrisklevel,
    Siteconfigintegrationtype,
    Siteconfigsitekey,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from ingestion.france_travail import (
    FranceTravailApiError,
    TOKEN_URL,
    ingest_france_travail_offers,
    search_offers,
)

# Shape mirrored from France Travail's real "Offres d'emploi v2" search
# response (recorded-fixture style, per this task's verify wording), not a
# live call.
FIXTURE_SEARCH_RESPONSE = {
    "resultats": [
        {
            "id": "123ABCD",
            "intitule": "Ingénieur logiciel backend",
            "description": "Développement d'API Python/FastAPI.",
            "dateCreation": "2026-08-01T09:00:00.000Z",
            "entreprise": {"nom": "Acme France"},
            "lieuTravail": {"libelle": "75 - Paris"},
            "typeContrat": "CDI",
            "typeContratLibelle": "Contrat à durée indéterminée",
            "experienceLibelle": "3 ans",
            "salaire": {"libelle": "Selon profil"},
            "competences": [{"libelle": "Python"}, {"libelle": "SQL"}],
            "origineOffre": {"origine": "1", "urlOrigine": "https://candidat.francetravail.fr/offres/recherche/detail/123ABCD"},
        },
        {
            "id": "456EFGH",
            "intitule": "Développeuse full-stack",
            "dateCreation": "2026-08-02T09:00:00.000Z",
            "entreprise": {"nom": "Beta SAS"},
            "lieuTravail": {"libelle": "69 - Lyon"},
            "competences": [],
            # No origineOffre: exercises the detail-URL fallback.
        },
    ]
}


def _france_travail_site_config() -> SiteConfig:
    return SiteConfig(
        id="site-france-travail",
        siteKey=Siteconfigsitekey.FRANCE_TRAVAIL,
        displayName="France Travail",
        baseUrl="https://www.francetravail.fr",
        searchUrlTemplate=None,
        filterParamMapping={
            "keywords": "motsCles",
            "location": "commune",
            "postedWithin": "minCreationDate",
            "contractType": "typeContrat",
            "remote": "travailATemps",
        },
        integrationType=Siteconfigintegrationtype.OFFICIAL_API,
        apiBaseUrl="https://api.francetravail.io/partenaire/offresdemploi/v2",
        requiresJsRendering=False,
        antiBotRiskLevel=Siteconfigantibotrisklevel.LOW,
        enabled=True,
    )


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


def _mock_token(respx_mock):
    respx_mock.post(TOKEN_URL).mock(
        return_value=Response(200, json={"access_token": "fake-token", "expires_in": 1499})
    )


@pytest.mark.asyncio
async def test_search_offers_returns_resultats_given_valid_filters(monkeypatch):
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_SECRET", "test-client-secret")
    site_config = _france_travail_site_config()

    with respx.mock:
        _mock_token(respx.mock)
        respx.mock.get(url__startswith="https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search").mock(
            return_value=Response(200, json=FIXTURE_SEARCH_RESPONSE)
        )

        offers = await search_offers(site_config, {"keywords": "python", "location": "Paris"})

    assert len(offers) == 2
    assert offers[0]["intitule"] == "Ingénieur logiciel backend"


@pytest.mark.asyncio
async def test_search_offers_raises_without_credentials(monkeypatch):
    monkeypatch.delenv("FRANCE_TRAVAIL_CLIENT_ID", raising=False)
    monkeypatch.delenv("FRANCE_TRAVAIL_CLIENT_SECRET", raising=False)

    with pytest.raises(FranceTravailApiError):
        await search_offers(_france_travail_site_config(), {"keywords": "python"})


@pytest.mark.asyncio
async def test_search_offers_raises_on_token_failure(monkeypatch):
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_SECRET", "wrong-secret")

    with respx.mock:
        respx.mock.post(TOKEN_URL).mock(return_value=Response(401, json={"error": "invalid_client"}))

        with pytest.raises(FranceTravailApiError):
            await search_offers(_france_travail_site_config(), {"keywords": "python"})


@pytest.mark.asyncio
async def test_ingest_france_travail_offers_creates_ready_job_offers_end_to_end(monkeypatch):
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_SECRET", "test-client-secret")

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    site_config = _france_travail_site_config()

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.SITE_SEARCH,
                siteConfigId=site_config.id,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=_now(),
            )
        )
        await session.commit()

    try:
        with respx.mock:
            _mock_token(respx.mock)
            respx.mock.get(
                url__startswith="https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search"
            ).mock(return_value=Response(200, json=FIXTURE_SEARCH_RESPONSE))

            async with session_factory() as session:
                ingestion_job = await session.get(IngestionJob, ingestion_job_id)
                job_offers = await ingest_france_travail_offers(
                    session, ingestion_job, site_config, {"keywords": "python", "location": "Paris"}
                )

        # >=1 offer returned end-to-end, per this task's literal verify wording.
        assert len(job_offers) == 2
        assert all(offer.extractionStatus == Jobofferextractionstatus.READY for offer in job_offers)
        assert all(offer.sourceSite == Joboffersourcesite.FRANCE_TRAVAIL for offer in job_offers)

        async with session_factory() as session:
            offer1 = await session.scalar(
                select(JobOffer).where(
                    JobOffer.sourceUrl == "https://candidat.francetravail.fr/offres/recherche/detail/123ABCD"
                )
            )
            assert offer1 is not None
            assert offer1.title == "Ingénieur logiciel backend"
            assert offer1.company == "Acme France"
            assert offer1.structuredData["requirements"] == ["Python", "SQL"]

            offer2 = await session.scalar(
                select(JobOffer).where(
                    JobOffer.sourceUrl == "https://candidat.francetravail.fr/offres/recherche/detail/456EFGH"
                )
            )
            assert offer2 is not None, "offer without origineOffre.urlOrigine should fall back to the detail URL"

            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            assert len(links) == 2

            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            assert ingestion_job.discoveredCount == 2
            assert ingestion_job.scrapedCount == 2
            assert ingestion_job.failedCount == 0
            assert ingestion_job.status == Ingestionjobstatus.COMPLETED
    finally:
        async with session_factory() as session:
            links = (
                await session.scalars(
                    select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == ingestion_job_id)
                )
            ).all()
            for link in links:
                await session.delete(link)
            await session.commit()

            offers = (
                await session.scalars(
                    select(JobOffer).where(
                        JobOffer.sourceUrl.in_(
                            [
                                "https://candidat.francetravail.fr/offres/recherche/detail/123ABCD",
                                "https://candidat.francetravail.fr/offres/recherche/detail/456EFGH",
                            ]
                        )
                    )
                )
            ).all()
            for offer in offers:
                await session.delete(offer)

            job = await session.get(IngestionJob, ingestion_job_id)
            if job is not None:
                await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_france_travail_offers_marks_ingestion_job_failed_on_api_error(monkeypatch):
    """PRD Section 8.5 step 5: "per-site failure ... marks the IngestionJob
    FAILED/PARTIALLY_COMPLETED with a clear errorMessage — never a silent
    zero-result return." A search/auth failure must not raise past this
    function leaving the IngestionJob stuck at its prior status.
    """
    monkeypatch.delenv("FRANCE_TRAVAIL_CLIENT_ID", raising=False)
    monkeypatch.delenv("FRANCE_TRAVAIL_CLIENT_SECRET", raising=False)

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    ingestion_job_id = f"test-job-{uuid.uuid4()}"
    site_config = _france_travail_site_config()

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        session.add(
            IngestionJob(
                id=ingestion_job_id,
                userId=user_id,
                mode=Ingestionmode.SITE_SEARCH,
                siteConfigId=site_config.id,
                maxOffers=25,
                status=Ingestionjobstatus.RUNNING,
                updatedAt=_now(),
            )
        )
        await session.commit()

    try:
        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            job_offers = await ingest_france_travail_offers(
                session, ingestion_job, site_config, {"keywords": "python"}
            )

        assert job_offers == []

        async with session_factory() as session:
            ingestion_job = await session.get(IngestionJob, ingestion_job_id)
            assert ingestion_job.status == Ingestionjobstatus.FAILED
            assert ingestion_job.errorMessage
    finally:
        async with session_factory() as session:
            job = await session.get(IngestionJob, ingestion_job_id)
            if job is not None:
                await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()


@pytest.mark.asyncio
async def test_ingest_france_travail_offers_reuses_globally_deduplicated_job_offer(monkeypatch):
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("FRANCE_TRAVAIL_CLIENT_SECRET", "test-client-secret")

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    job_a_id = f"test-job-{uuid.uuid4()}"
    job_b_id = f"test-job-{uuid.uuid4()}"
    site_config = _france_travail_site_config()
    single_offer_response = {"resultats": [FIXTURE_SEARCH_RESPONSE["resultats"][0]]}

    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=_now()))
        for job_id in (job_a_id, job_b_id):
            session.add(
                IngestionJob(
                    id=job_id,
                    userId=user_id,
                    mode=Ingestionmode.SITE_SEARCH,
                    siteConfigId=site_config.id,
                    maxOffers=25,
                    status=Ingestionjobstatus.RUNNING,
                    updatedAt=_now(),
                )
            )
        await session.commit()

    try:
        with respx.mock:
            _mock_token(respx.mock)
            respx.mock.get(
                url__startswith="https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search"
            ).mock(return_value=Response(200, json=single_offer_response))

            async with session_factory() as session:
                job_a = await session.get(IngestionJob, job_a_id)
                await ingest_france_travail_offers(session, job_a, site_config, {"keywords": "python"})

            async with session_factory() as session:
                job_b = await session.get(IngestionJob, job_b_id)
                await ingest_france_travail_offers(session, job_b, site_config, {"keywords": "python"})

        async with session_factory() as session:
            offers = (
                await session.scalars(
                    select(JobOffer).where(
                        JobOffer.sourceUrl
                        == "https://candidat.francetravail.fr/offres/recherche/detail/123ABCD"
                    )
                )
            ).all()
            assert len(offers) == 1, "the same France Travail offer must not be duplicated across ingestion jobs"
    finally:
        async with session_factory() as session:
            for job_id in (job_a_id, job_b_id):
                links = (
                    await session.scalars(
                        select(IngestionJobOffer).where(IngestionJobOffer.ingestionJobId == job_id)
                    )
                ).all()
                for link in links:
                    await session.delete(link)
            await session.commit()

            offer = await session.scalar(
                select(JobOffer).where(
                    JobOffer.sourceUrl == "https://candidat.francetravail.fr/offres/recherche/detail/123ABCD"
                )
            )
            if offer is not None:
                await session.delete(offer)

            for job_id in (job_a_id, job_b_id):
                job = await session.get(IngestionJob, job_id)
                if job is not None:
                    await session.delete(job)
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
            await session.commit()
        await engine.dispose()
