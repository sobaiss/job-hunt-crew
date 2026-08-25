import json
import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    Cvparsestatus,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    User,
)
from py_db.session import make_engine, make_session_factory

from analysis.comparison_crew import AnalysisError, run_analysis
from analysis.llm_provider import LLMProvider

JOB_OFFER_STRUCTURED_DATA = {
    "description": "Senior Backend Engineer role focused on Python services.",
    "requirements": ["5+ years Python", "AWS experience"],
    "salary": "€60k-€75k",
    "contractType": "full_time",
    "remotePolicy": "hybrid",
    "seniority": "senior",
}
CV_STRUCTURED_DATA = {
    "skills": ["Python", "AWS", "PostgreSQL"],
    "experience": [
        {
            "title": "Backend Engineer",
            "company": "Acme Corp",
            "startDate": "2021-01",
            "endDate": None,
            "description": "Built backend services.",
        }
    ],
    "education": [],
}
VALID_COMPARISON_OUTPUT = json.dumps(
    {
        "match_score": 82,
        "matched_skills": [{"skill": "Python", "evidence": "5+ years Python experience"}],
        "missing_skills": [{"skill": "Kubernetes", "importance": "nice_to_have"}],
        "strengths": ["Strong Python background"],
        "weaknesses": ["No Kubernetes experience"],
    }
)
VALID_RECOMMENDATION_OUTPUT = json.dumps(
    {
        "improvement_suggestions": [
            {
                "area": "Kubernetes",
                "suggestion": "Get hands-on Kubernetes experience.",
                "priority": "medium",
            }
        ],
        "summary": "Strong match on core skills; consider closing the Kubernetes gap.",
    }
)


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0
        self.model = "stub-model"

    def generate(self, *, system: str, prompt: str) -> str:
        self.calls += 1
        return self._responses[min(self.calls, len(self._responses)) - 1]


def _now():
    return datetime.now(UTC).replace(tzinfo=None)


async def _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id):
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.READY,
                structuredData=JOB_OFFER_STRUCTURED_DATA,
                updatedAt=now,
            )
        )
        session.add(
            CVVersion(
                id=cv_version_id,
                userId=user_id,
                label="Software Engineer",
                fileKey=f"cvs/{user_id}/{cv_version_id}/cv.pdf",
                fileName="cv.pdf",
                fileType=Cvfiletype.PDF,
                fileSizeBytes=1024,
                parseStatus=Cvparsestatus.PARSED,
                structuredData=CV_STRUCTURED_DATA,
                updatedAt=now,
            )
        )
        session.add(
            Analysis(
                id=analysis_id,
                userId=user_id,
                jobOfferId=job_offer_id,
                cvVersionId=cv_version_id,
                status=Analysisstatus.PENDING,
            )
        )
        await session.commit()


async def _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id):
    async with session_factory() as session:
        for model, row_id in (
            (Analysis, analysis_id),
            (CVVersion, cv_version_id),
            (JobOffer, job_offer_id),
            (User, user_id),
        ):
            row = await session.get(model, row_id)
            if row is not None:
                await session.delete(row)
        await session.commit()
    await engine.dispose()


@pytest.mark.asyncio
async def test_run_analysis_produces_section_8_6_schema_and_completes():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT])

    try:
        async with session_factory() as session:
            analysis = await run_analysis(session, analysis_id, llm_provider=provider)
            assert analysis.status == Analysisstatus.COMPLETED
            assert analysis.matchScore == 82
            result = analysis.resultJSON
            assert result["match_score"] == 82
            assert result["matched_skills"] == [
                {"skill": "Python", "evidence": "5+ years Python experience"}
            ]
            assert result["missing_skills"] == [
                {"skill": "Kubernetes", "importance": "nice_to_have"}
            ]
            assert result["strengths"] == ["Strong Python background"]
            assert result["weaknesses"] == ["No Kubernetes experience"]
            assert result["improvement_suggestions"] == [
                {
                    "area": "Kubernetes",
                    "suggestion": "Get hands-on Kubernetes experience.",
                    "priority": "medium",
                }
            ]
            assert result["summary"]
            assert result["generated_at"]
            assert result["model_used"] == "stub-model"
            assert result["job_offer_id"] == job_offer_id
            assert result["cv_version_id"] == cv_version_id

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.COMPLETED
            assert reloaded.matchScore == 82
            assert reloaded.resultJSON["job_offer_id"] == job_offer_id
            assert reloaded.completedAt is not None
        assert provider.calls == 2
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_analysis_fails_with_error_message_on_malformed_comparison_output():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    provider = StubLLMProvider(["not valid json"])

    try:
        async with session_factory() as session:
            with pytest.raises(AnalysisError):
                await run_analysis(session, analysis_id, llm_provider=provider)

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
            assert reloaded.resultJSON is None
            assert reloaded.matchScore is None
        # Bounded retries: exactly MAX_ATTEMPTS calls for the comparison agent, no
        # recommendation-agent calls once the comparison step already failed.
        assert provider.calls == 3
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_run_analysis_fails_when_job_offer_not_ready():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-{uuid.uuid4()}"
    job_offer_id = f"test-{uuid.uuid4()}"
    cv_version_id = f"test-{uuid.uuid4()}"
    analysis_id = f"test-{uuid.uuid4()}"

    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    async with session_factory() as session:
        job_offer = await session.get(JobOffer, job_offer_id)
        job_offer.extractionStatus = Jobofferextractionstatus.SCRAPED
        job_offer.structuredData = None
        await session.commit()

    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT, VALID_RECOMMENDATION_OUTPUT])

    try:
        async with session_factory() as session:
            with pytest.raises(AnalysisError):
                await run_analysis(session, analysis_id, llm_provider=provider)

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage
        assert provider.calls == 0
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
