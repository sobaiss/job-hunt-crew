"""M6-T3: a full pipeline run (scrape -> extract -> convert -> crew -> persist)
emits a PipelineEvent row for every one of those stages, per PRD Section 11's
"structured logs across Lambda/Fargate steps" + PipelineEvent trail
requirement. Lives in services/ingestion (not services/analysis) since only
ingestion depends on analysis (not the reverse) and this test needs both
scrape_job_offer (ingestion) and extract_job_offer/convert_cv/run_crew_task/
persist_analysis_result (analysis).
"""

import json
import uuid
from datetime import UTC, datetime
from io import BytesIO

import boto3
import pytest
import respx
from botocore.client import Config
from docx import Document
from httpx import Response
from py_db.models import (
    Analysis,
    Analysisstatus,
    CVVersion,
    Cvfiletype,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    PipelineEvent,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import or_, select

from analysis.crew_task import run_crew_task
from analysis.cv_conversion import convert_cv
from analysis.job_offer_extraction_agent import extract_job_offer
from analysis.llm_provider import LLMProvider
from analysis.persist_result_lambda import persist_analysis_result
from analysis.s3_client import S3_BUCKET as ANALYSIS_S3_BUCKET
from analysis.s3_client import analysis_result_key

from ingestion.s3_client import raw_scrape_key
from ingestion.scrape import scrape_job_offer

FIXTURE_HTML = "<html><body><h1>Senior Backend Engineer</h1></body></html>"

JOB_OFFER_LLM_OUTPUT = json.dumps(
    {
        "description": "Senior Backend Engineer role focused on Python services.",
        "requirements": ["5+ years Python", "AWS experience"],
        "salary": "€60k-€75k",
        "contractType": "full_time",
        "remotePolicy": "hybrid",
        "seniority": "senior",
    }
)
# convert_cv's DOCX branch runs one LLM normalisation pass whose output is
# taken as the Markdown rendition verbatim.
CV_LLM_OUTPUT = "# Jane Doe\n\n## Skills\n\n- Python\n- AWS\n"
COMPARISON_LLM_OUTPUT = json.dumps(
    {
        "match_score": 82,
        "matched_skills": [{"skill": "Python", "evidence": "5+ years Python experience"}],
        "missing_skills": [],
        "strengths": ["Strong Python background"],
        "weaknesses": [],
    }
)
RECOMMENDATION_LLM_OUTPUT = json.dumps(
    {"improvement_suggestions": [], "summary": "Strong match on core skills."}
)


class SequentialStubLLMProvider(LLMProvider):
    """Unlike the other tests' StubLLMProvider (which repeats its last
    response forever), this pipeline calls the LLM 4 times across 4
    different stages, each expecting a distinct response in order.
    """

    def __init__(self, responses: list[str]):
        self._responses = list(responses)
        self.calls = 0
        self.model = "stub-model"

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
        response = self._responses[self.calls]
        self.calls += 1
        return response


def _build_fixture_docx_bytes(text: str) -> bytes:
    document = Document()
    document.add_paragraph(text)
    buf = BytesIO()
    document.save(buf)
    return buf.getvalue()


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


@pytest.mark.asyncio
async def test_full_pipeline_run_produces_a_pipeline_event_per_stage():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id = f"test-user-{uuid.uuid4()}"
    job_offer_id = f"test-offer-{uuid.uuid4()}"
    cv_version_id = f"test-cv-{uuid.uuid4()}"
    analysis_id = f"test-analysis-{uuid.uuid4()}"
    source_url = f"https://example.com/jobs/{job_offer_id}"
    cv_file_key = f"cvs/{user_id}/{cv_version_id}/cv.docx"

    cv_docx_bytes = _build_fixture_docx_bytes("Senior backend engineer with 5 years Python.")
    s3 = _s3_client()
    s3.put_object(
        Bucket=ANALYSIS_S3_BUCKET,
        Key=cv_file_key,
        Body=cv_docx_bytes,
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=source_url,
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=Jobofferextractionstatus.PENDING,
                updatedAt=now,
            )
        )
        session.add(
            CVVersion(
                id=cv_version_id,
                userId=user_id,
                label="Software Engineer",
                fileKey=cv_file_key,
                fileName="cv.docx",
                fileType=Cvfiletype.DOCX,
                fileSizeBytes=len(cv_docx_bytes),
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

    provider = SequentialStubLLMProvider(
        [JOB_OFFER_LLM_OUTPUT, CV_LLM_OUTPUT, COMPARISON_LLM_OUTPUT, RECOMMENDATION_LLM_OUTPUT]
    )
    result_key = analysis_result_key(analysis_id)

    try:
        with respx.mock(assert_all_called=True) as mock:
            mock.get(source_url).mock(return_value=Response(200, text=FIXTURE_HTML))
            async with session_factory() as session:
                await scrape_job_offer(session, job_offer_id)

        async with session_factory() as session:
            await extract_job_offer(session, job_offer_id, llm_provider=provider, analysis_id=analysis_id)

        async with session_factory() as session:
            await convert_cv(session, cv_version_id, llm_provider=provider, analysis_id=analysis_id)

        async with session_factory() as session:
            await run_crew_task(session, analysis_id, llm_provider=provider, s3_client=s3)

        async with session_factory() as session:
            analysis = await persist_analysis_result(session, analysis_id, s3_client=s3)
            assert analysis.status == Analysisstatus.COMPLETED

        # The task's literal verification: a full pipeline run produces a
        # PipelineEvent row per stage (scrape, extract, convert, crew, persist).
        # scrape's events aren't tagged with analysisId (scrape_job_offer ran
        # with no ingestion_job_id in this direct-to-analysis scenario), so
        # match them by the job_offer_id embedded in their message instead.
        async with session_factory() as session:
            events = (
                await session.scalars(
                    select(PipelineEvent).where(
                        or_(
                            PipelineEvent.analysisId == analysis_id,
                            PipelineEvent.message.contains(job_offer_id),
                        )
                    )
                )
            ).all()

        stages_seen = {event.stage for event in events}
        assert stages_seen == {"scrape", "extract", "convert", "crew", "persist"}
        # Each stage recorded at least a STARTED and a SUCCEEDED transition.
        for stage in ("scrape", "extract", "convert", "crew", "persist"):
            statuses = {event.status for event in events if event.stage == stage}
            assert "SUCCEEDED" in statuses
    finally:
        s3.delete_object(Bucket=ANALYSIS_S3_BUCKET, Key=cv_file_key)
        try:
            s3.delete_object(Bucket=ANALYSIS_S3_BUCKET, Key=result_key)
        except Exception:
            pass
        try:
            s3.delete_object(Bucket=ANALYSIS_S3_BUCKET, Key=raw_scrape_key(job_offer_id))
        except Exception:
            pass
        async with session_factory() as session:
            events = (
                await session.scalars(
                    select(PipelineEvent).where(
                        or_(
                            PipelineEvent.analysisId == analysis_id,
                            PipelineEvent.message.contains(job_offer_id),
                        )
                    )
                )
            ).all()
            for event in events:
                await session.delete(event)
            await session.commit()
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
