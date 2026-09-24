"""`GET /v1/analyses`' filtering, sorting and pagination, plus the two reads
that came with them (`/analyses/stats`, `/analyses/cv-labels`).

All three used to happen in the browser, over the whole list: the endpoint
returned every Analysis a candidate had, `resultJSON` included, and
`lib/analyses-filters.ts` narrowed, sorted and sliced it. These are the tests
for the semantics that moved here -- the frontend's own suite now only checks
that it sends the right query parameters and renders what comes back.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from py_db.models import (
    Analysis,
    Analysisstatus,
    Application,
    Applicationstatus,
    CVVersion,
    Cvfiletype,
    GeneratedDocument,
    Generateddocumentstatus,
    Generateddocumenttype,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import delete, select

from api.main import app

HEADERS = {"X-Internal-Api-Secret": "test-secret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "test-secret")


def _headers(user_id: str) -> dict[str, str]:
    return {**HEADERS, "X-User-Id": user_id}


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _seed(specs: list[dict]) -> tuple[str, list[str]]:
    """One user, and one Analysis per spec, created in a single session.

    Every field a spec omits gets a value that no filter in these tests
    matches on, so each test can name only what it is about.
    """
    user_id = str(uuid.uuid4())
    job_offer_ids: list[str] = []
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            session.add(User(id=user_id, email=f"{user_id}@example.com", updatedAt=_now()))
            cv_ids: dict[str, str] = {}
            for index, spec in enumerate(specs):
                label = spec.get("cvLabel", "CV 1")
                if label not in cv_ids:
                    cv_id = str(uuid.uuid4())
                    cv_ids[label] = cv_id
                    session.add(
                        CVVersion(
                            id=cv_id,
                            userId=user_id,
                            label=label,
                            fileKey=f"cv-versions/{user_id}/{cv_id}/cv.pdf",
                            fileName="cv.pdf",
                            fileType=Cvfiletype.PDF,
                            fileSizeBytes=1024,
                            updatedAt=_now(),
                        )
                    )
                cv_version_id = cv_ids[label]

                job_offer_id = str(uuid.uuid4())
                job_offer_ids.append(job_offer_id)
                session.add(
                    JobOffer(
                        id=job_offer_id,
                        sourceUrl=f"https://example.com/{job_offer_id}",
                        sourceSite=spec.get("sourceSite", Joboffersourcesite.OTHER),
                        extractionStatus=Jobofferextractionstatus.READY,
                        title=spec.get("title", f"Role {index}"),
                        company=spec.get("company", "Acme"),
                        location=spec.get("location", "Paris"),
                        postedAt=spec.get("postedAt"),
                        updatedAt=_now(),
                    )
                )

                analysis_id = str(uuid.uuid4())
                spec["id"] = analysis_id
                analysis = Analysis(
                    id=analysis_id,
                    userId=user_id,
                    jobOfferId=job_offer_id,
                    cvVersionId=cv_version_id,
                    status=spec.get("status", Analysisstatus.COMPLETED),
                    matchScore=spec.get("matchScore"),
                )
                if spec.get("requestedAt") is not None:
                    analysis.requestedAt = spec["requestedAt"]
                session.add(analysis)

                if spec.get("applicationStatus") is not None:
                    session.add(
                        Application(
                            id=str(uuid.uuid4()),
                            userId=user_id,
                            analysisId=analysis_id,
                            jobOfferId=job_offer_id,
                            cvVersionId=cv_version_id,
                            status=spec["applicationStatus"],
                            updatedAt=_now(),
                        )
                    )
                for doc_type, key in (
                    (Generateddocumenttype.TAILORED_CV, "tailoredCvStatus"),
                    (Generateddocumenttype.COVER_LETTER, "coverLetterStatus"),
                ):
                    if spec.get(key) is not None:
                        session.add(
                            GeneratedDocument(
                                id=str(uuid.uuid4()),
                                type=doc_type,
                                analysisId=analysis_id,
                                jobOfferId=job_offer_id,
                                cvVersionId=cv_version_id,
                                status=spec[key],
                                updatedAt=_now(),
                            )
                        )
            await session.commit()
    finally:
        await engine.dispose()
    return user_id, job_offer_ids


async def _cleanup(user_id: str, job_offer_ids: list[str]) -> None:
    engine = make_engine()
    try:
        session_factory = make_session_factory(engine)
        async with session_factory() as session:
            # GeneratedDocument.cvVersionId is ON DELETE RESTRICT, so those rows
            # go before the CVVersion cascade from User can reach them.
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
            if job_offer_ids:
                await session.execute(delete(JobOffer).where(JobOffer.id.in_(job_offer_ids)))
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def seed():
    created: list[tuple[str, list[str]]] = []

    def _make(specs: list[dict]) -> str:
        user_id, job_offer_ids = asyncio.run(_seed(specs))
        created.append((user_id, job_offer_ids))
        return user_id

    yield _make
    for user_id, job_offer_ids in created:
        asyncio.run(_cleanup(user_id, job_offer_ids))


def _titles(payload: dict) -> list[str]:
    return [row["jobOffer"]["title"] for row in payload["analyses"]]


def test_paginates_with_a_default_page_size_and_reports_the_total(seed):
    user_id = seed([{"title": f"Role {index:02d}"} for index in range(30)])

    with TestClient(app) as client:
        first = client.get("/v1/analyses", headers=_headers(user_id)).json()
        second = client.get("/v1/analyses?page=2", headers=_headers(user_id)).json()

    assert first["total"] == 30
    assert first["pageSize"] == 25
    assert len(first["analyses"]) == 25
    assert len(second["analyses"]) == 5
    assert set(_titles(first)).isdisjoint(_titles(second))


def test_clamps_a_page_past_the_end_and_says_which_page_it_served(seed):
    # A `?page=9` outlived by a filter or a deletion is a stale link, not a
    # request for an empty table.
    user_id = seed([{"title": f"Role {index}"} for index in range(3)])

    with TestClient(app) as client:
        payload = client.get("/v1/analyses?page=9&pageSize=2", headers=_headers(user_id)).json()

    assert payload["page"] == 2
    assert payload["total"] == 3
    assert len(payload["analyses"]) == 1


def test_searches_title_and_company_case_insensitively(seed):
    user_id = seed(
        [
            {"title": "Backend Engineer", "company": "Acme"},
            {"title": "Designer", "company": "BACKEND Labs"},
            {"title": "Data Scientist", "company": "Globex"},
        ]
    )

    with TestClient(app) as client:
        payload = client.get("/v1/analyses?q=backend", headers=_headers(user_id)).json()

    assert sorted(_titles(payload)) == ["Backend Engineer", "Designer"]
    assert payload["total"] == 2


def test_filters_by_location_cv_label_and_platform(seed):
    user_id = seed(
        [
            {
                "title": "Match",
                "location": "Lyon",
                "cvLabel": "Grad CV",
                "sourceSite": Joboffersourcesite.LINKEDIN,
            },
            {"title": "Wrong city", "location": "Paris", "cvLabel": "Grad CV"},
            {"title": "Wrong cv", "location": "Lyon", "cvLabel": "Senior CV"},
        ]
    )

    with TestClient(app) as client:
        by_location = client.get("/v1/analyses?location=lyo", headers=_headers(user_id)).json()
        by_cv = client.get("/v1/analyses?cv=Senior%20CV", headers=_headers(user_id)).json()
        by_platform = client.get(
            "/v1/analyses?platform=LINKEDIN,INDEED", headers=_headers(user_id)
        ).json()

    assert sorted(_titles(by_location)) == ["Match", "Wrong cv"]
    assert _titles(by_cv) == ["Wrong cv"]
    assert _titles(by_platform) == ["Match"]


def test_ors_several_status_buckets_together(seed):
    # The candidate's filter takes any number of buckets at once, where the
    # Admin table takes exactly one -- the vocabulary is shared, the
    # interaction is not.
    user_id = seed(
        [
            {"title": "To apply", "status": Analysisstatus.COMPLETED},
            {
                "title": "In progress",
                "status": Analysisstatus.COMPLETED,
                "applicationStatus": Applicationstatus.INTERVIEWING,
            },
            {"title": "Waiting", "status": Analysisstatus.PENDING},
            {"title": "Broken", "status": Analysisstatus.FAILED},
            {"title": "Running", "status": Analysisstatus.RUNNING_CREW},
        ]
    )

    with TestClient(app) as client:
        payload = client.get(
            "/v1/analyses?status=TO_APPLY,FAILED", headers=_headers(user_id)
        ).json()

    assert sorted(_titles(payload)) == ["Broken", "To apply"]


def test_rejects_a_status_or_platform_value_the_filter_does_not_offer(seed):
    user_id = seed([{"title": "Role"}])

    with TestClient(app) as client:
        assert client.get("/v1/analyses?status=NOPE", headers=_headers(user_id)).status_code == 422
        assert (
            client.get("/v1/analyses?platform=MYSPACE", headers=_headers(user_id)).status_code
            == 422
        )


def test_filters_by_the_requested_at_range(seed):
    now = _now()
    user_id = seed(
        [
            {"title": "Old", "requestedAt": now - timedelta(days=10)},
            {"title": "Recent", "requestedAt": now - timedelta(days=1)},
        ]
    )
    cutoff = (now - timedelta(days=5)).isoformat()

    with TestClient(app) as client:
        payload = client.get(
            f"/v1/analyses?requestedAtFrom={cutoff}", headers=_headers(user_id)
        ).json()

    assert _titles(payload) == ["Recent"]


def test_sorts_nulls_last_in_both_directions(seed):
    user_id = seed(
        [
            {"title": "Scored high", "matchScore": 90},
            {"title": "Scored low", "matchScore": 10},
            {"title": "Unscored", "matchScore": None},
        ]
    )

    with TestClient(app) as client:
        descending = client.get(
            "/v1/analyses?sort=matchScore&dir=desc", headers=_headers(user_id)
        ).json()
        ascending = client.get(
            "/v1/analyses?sort=matchScore&dir=asc", headers=_headers(user_id)
        ).json()

    assert _titles(descending) == ["Scored high", "Scored low", "Unscored"]
    assert _titles(ascending) == ["Scored low", "Scored high", "Unscored"]


def test_sorts_text_case_insensitively(seed):
    user_id = seed([{"title": "banana"}, {"title": "Apple"}, {"title": "cherry"}])

    with TestClient(app) as client:
        payload = client.get("/v1/analyses?sort=title&dir=asc", headers=_headers(user_id)).json()

    assert _titles(payload) == ["Apple", "banana", "cherry"]


def test_sorts_by_a_generated_documents_status(seed):
    # `tailoredCvStatus` is computed per row from the current, non-superseded
    # GeneratedDocument, so sorting by it is a correlated subquery rather than
    # a column.
    user_id = seed(
        [
            {"title": "Ready", "tailoredCvStatus": Generateddocumentstatus.READY},
            {"title": "Failed", "tailoredCvStatus": Generateddocumentstatus.FAILED},
            {"title": "None yet"},
        ]
    )

    with TestClient(app) as client:
        payload = client.get(
            "/v1/analyses?sort=tailoredCvStatus&dir=asc", headers=_headers(user_id)
        ).json()

    assert _titles(payload) == ["Failed", "Ready", "None yet"]


def test_rows_tied_on_the_sort_column_fall_back_to_a_total_order(seed):
    # Rows sharing a sort value have no order of their own, and an unordered
    # remainder is what makes paginated results drop and repeat rows between
    # two requests. The default sort is `postedAt`, NULL in bulk, so this is
    # the common case rather than a corner.
    #
    # Asserting the tie-break's own order rather than trying to provoke the
    # instability: with 20 rows Postgres happens to return a stable order
    # anyway, so a "the pages stay disjoint" test passes with or without the
    # ORDER BY and proves nothing. These rows are seeded oldest-first, so
    # insertion order is the exact opposite of the `requestedAt DESC` the
    # tie-break asks for.
    now = _now()
    user_id = seed(
        [
            {
                "title": f"Role {index:02d}",
                "postedAt": None,
                "requestedAt": now - timedelta(days=20 - index),
            }
            for index in range(20)
        ]
    )

    with TestClient(app) as client:
        seen: list[str] = []
        for page in (1, 2, 3, 4):
            payload = client.get(
                f"/v1/analyses?page={page}&pageSize=5", headers=_headers(user_id)
            ).json()
            seen.extend(_titles(payload))

    assert seen == [f"Role {index:02d}" for index in reversed(range(20))]


def test_a_job_offer_scoped_list_is_not_paginated(seed):
    # The Side-by-side comparison asks for one JobOffer's analyses; that scope
    # bounds itself, and its caller pages nothing.
    user_id = seed([{"title": f"Role {index}"} for index in range(30)])
    with TestClient(app) as client:
        all_rows = client.get("/v1/analyses?pageSize=100", headers=_headers(user_id)).json()
        job_offer_id = all_rows["analyses"][0]["jobOffer"]["id"]
        scoped = client.get(
            f"/v1/analyses?jobOfferId={job_offer_id}", headers=_headers(user_id)
        ).json()

    assert len(scoped["analyses"]) == scoped["total"] == 1


def test_only_lists_the_callers_own_analyses(seed):
    mine = seed([{"title": "Mine"}])
    seed([{"title": "Theirs"}])

    with TestClient(app) as client:
        payload = client.get("/v1/analyses", headers=_headers(mine)).json()

    assert _titles(payload) == ["Mine"]


def test_stats_summarise_every_analysis_not_a_page(seed):
    now = _now()
    user_id = seed(
        [
            {
                "title": "Best",
                "company": "Globex",
                "matchScore": 90,
                "requestedAt": now - timedelta(days=1),
            },
            {"title": "Middling", "matchScore": 50, "requestedAt": now - timedelta(days=2)},
            # Scored but not COMPLETED, and COMPLETED but unscored: neither
            # counts towards the scores, matching the client's own `isScored`.
            {
                "title": "Running",
                "status": Analysisstatus.RUNNING_CREW,
                "matchScore": 100,
                "requestedAt": now - timedelta(days=30),
            },
            {"title": "Unscored", "matchScore": None, "requestedAt": now - timedelta(days=30)},
        ]
    )

    with TestClient(app) as client:
        stats = client.get("/v1/analyses/stats", headers=_headers(user_id)).json()

    assert stats["analysisCount"] == 4
    assert stats["averageScore"] == 70
    assert stats["bestScore"] == 90
    assert stats["bestScoreOffer"] == {"title": "Best", "company": "Globex"}
    assert stats["analysesThisWeek"] == 2
    assert stats["hasComparison"] is False
    assert [point["score"] for point in stats["trend"]] == [50, 90]


def test_stats_report_a_job_offer_analysed_twice_as_a_comparison(seed):
    user_id = seed([{"title": "Role"}])
    with TestClient(app) as client:
        payload = client.get("/v1/analyses", headers=_headers(user_id)).json()
        job_offer_id = payload["analyses"][0]["jobOffer"]["id"]

    # A second Analysis of the same JobOffer against another CVVersion -- what
    # the Dashboard's third onboarding step is waiting for.
    async def _add_second():
        engine = make_engine()
        try:
            session_factory = make_session_factory(engine)
            async with session_factory() as session:
                cv_id = str(uuid.uuid4())
                session.add(
                    CVVersion(
                        id=cv_id,
                        userId=user_id,
                        label="Other CV",
                        fileKey=f"cv-versions/{user_id}/{cv_id}/cv.pdf",
                        fileName="cv.pdf",
                        fileType=Cvfiletype.PDF,
                        fileSizeBytes=1024,
                        updatedAt=_now(),
                    )
                )
                session.add(
                    Analysis(
                        id=str(uuid.uuid4()),
                        userId=user_id,
                        jobOfferId=job_offer_id,
                        cvVersionId=cv_id,
                        status=Analysisstatus.COMPLETED,
                    )
                )
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(_add_second())

    with TestClient(app) as client:
        stats = client.get("/v1/analyses/stats", headers=_headers(user_id)).json()

    assert stats["hasComparison"] is True


def test_cv_labels_lists_the_labels_the_analyses_actually_use(seed):
    user_id = seed(
        [
            {"title": "One", "cvLabel": "Senior CV"},
            {"title": "Two", "cvLabel": "Grad CV"},
            {"title": "Three", "cvLabel": "Grad CV"},
        ]
    )

    with TestClient(app) as client:
        payload = client.get("/v1/analyses/cv-labels", headers=_headers(user_id)).json()

    assert payload["labels"] == ["Grad CV", "Senior CV"]


def test_stats_and_cv_labels_are_not_read_as_an_analysis_id(seed):
    # Both live under `/analyses/...`, where `/analyses/{analysis_id}` would
    # happily swallow them if they were declared after it.
    user_id = seed([{"title": "Role"}])

    with TestClient(app) as client:
        assert client.get("/v1/analyses/stats", headers=_headers(user_id)).status_code == 200
        assert client.get("/v1/analyses/cv-labels", headers=_headers(user_id)).status_code == 200
