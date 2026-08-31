import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import (
    Analysis,
    Analysisstatus,
    Cvconversionstatus,
    CVVersion,
    Cvfiletype,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
    PipelineEvent,
    User,
)
from py_db.session import make_engine, make_session_factory
from sqlalchemy import select

from analysis.handlers import (
    HandlerError,
    ensure_cv_converted,
    ensure_offer_extracted,
    mark_analysis_failed,
    run_comparison_crew_handler,
)
from analysis.llm_provider import LLMProvider


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    def generate(self, *, system: str, prompt: str) -> str:
        self.calls += 1
        return self._responses[min(self.calls, len(self._responses)) - 1]


async def _make_fixture(
    session_factory,
    user_id,
    job_offer_id,
    cv_version_id,
    analysis_id,
    *,
    offer_extraction_status: Jobofferextractionstatus,
):
    now = _now()
    async with session_factory() as session:
        session.add(User(id=user_id, updatedAt=now))
        session.add(
            JobOffer(
                id=job_offer_id,
                sourceUrl=f"https://example.com/jobs/{job_offer_id}",
                sourceSite=Joboffersourcesite.OTHER,
                extractionStatus=offer_extraction_status,
                rawContentKey=f"raw-scrapes/{job_offer_id}.html",
                structuredData=(
                    {"description": "x", "requirements": []}
                    if offer_extraction_status == Jobofferextractionstatus.READY
                    else None
                ),
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
        # PipelineEvent.analysisId (M6-T3) has ON DELETE CASCADE at the DB
        # level, but SQLAlchemy's default relationship handling nulls
        # rather than deletes orphaned children when the parent is removed
        # via the ORM — so delete these explicitly first, same as any other
        # FK'd row, rather than relying on the DB-level cascade.
        events = (await session.scalars(select(PipelineEvent).where(PipelineEvent.analysisId == analysis_id))).all()
        for event in events:
            await session.delete(event)
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
async def test_ensure_cv_converted_is_a_noop_when_already_converted(monkeypatch):
    import analysis.handlers as handlers_module

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )
    async with session_factory() as session:
        cv_version = await session.get(CVVersion, cv_version_id)
        cv_version.conversionStatus = Cvconversionstatus.CONVERTED
        cv_version.markdownContent = "# Already converted\n"
        await session.commit()

    calls = {"n": 0}

    async def _spy(*args, **kwargs):
        calls["n"] += 1

    monkeypatch.setattr(handlers_module, "convert_cv", _spy)

    try:
        async with session_factory() as session:
            await ensure_cv_converted(session, analysis_id)
        assert calls["n"] == 0
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_ensure_cv_converted_runs_conversion_when_not_yet_converted():
    import boto3
    from botocore.client import Config

    from analysis.s3_client import S3_BUCKET

    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )

    s3 = boto3.client(
        "s3",
        endpoint_url="http://localhost:9000",
        region_name="us-east-1",
        aws_access_key_id="minioadmin",
        aws_secret_access_key="minioadmin",
        config=Config(s3={"addressing_style": "path"}),
    )
    markdown = "# Jane Doe\n\n## Skills\n\n- Python\n"
    async with session_factory() as session:
        cv_version = await session.get(CVVersion, cv_version_id)
        cv_version.fileType = Cvfiletype.MD
        cv_version.fileKey = f"cvs/{user_id}/{cv_version_id}/cv.md"
        cv_version.fileName = "cv.md"
        await session.commit()
        file_key = cv_version.fileKey
    s3.put_object(Bucket=S3_BUCKET, Key=file_key, Body=markdown.encode("utf-8"))

    try:
        async with session_factory() as session:
            await ensure_cv_converted(session, analysis_id)

        async with session_factory() as session:
            reloaded = await session.get(CVVersion, cv_version_id)
            assert reloaded.conversionStatus == Cvconversionstatus.CONVERTED
            assert reloaded.markdownContent == markdown
    finally:
        s3.delete_object(Bucket=S3_BUCKET, Key=file_key)
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_ensure_offer_extracted_is_a_noop_when_already_ready():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_extraction_status=Jobofferextractionstatus.READY,
    )
    provider = StubLLMProvider(["should never be called"])

    try:
        async with session_factory() as session:
            await ensure_offer_extracted(session, analysis_id, llm_provider=provider)
        assert provider.calls == 0
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_ensure_cv_converted_raises_when_analysis_missing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    try:
        async with session_factory() as session:
            with pytest.raises(HandlerError):
                await ensure_cv_converted(session, "does-not-exist")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_mark_analysis_failed_sets_terminal_status_from_plain_cause():
    # M5-T5: the Catch target's error shape when Cause is already a plain
    # message (e.g. crew_task's own SendTaskFailure `cause=`).
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )
    try:
        async with session_factory() as session:
            await mark_analysis_failed(
                session,
                analysis_id,
                {"Error": "CrewTaskError", "Cause": "CVVersion is not CONVERTED with markdownContent"},
            )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage == "CVVersion is not CONVERTED with markdownContent"
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_mark_analysis_failed_unwraps_json_lambda_error_cause():
    # M5-T5: the Catch target's error shape for a raised exception inside
    # ensure_cv_converted_handler/ensure_offer_extracted_handler — AWS Lambda
    # (and lambda_shim, standing in for it locally) reports handler errors
    # as a JSON-encoded {"errorMessage": ..., "errorType": ...} body, which
    # Step Functions surfaces verbatim as the Catch's string Cause.
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )
    try:
        async with session_factory() as session:
            await mark_analysis_failed(
                session,
                analysis_id,
                {
                    "Error": "CVExtractionError",
                    "Cause": '{"errorMessage": "bounded retries exhausted", "errorType": "CVExtractionError"}',
                },
            )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.FAILED
            assert reloaded.errorMessage == "bounded retries exhausted"
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_mark_analysis_failed_does_not_clobber_an_already_failed_analysis():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(
        session_factory,
        user_id,
        job_offer_id,
        cv_version_id,
        analysis_id,
        offer_extraction_status=Jobofferextractionstatus.SCRAPED,
    )
    try:
        async with session_factory() as session:
            analysis = await session.get(Analysis, analysis_id)
            analysis.status = Analysisstatus.FAILED
            analysis.errorMessage = "original, more specific reason"
            await session.commit()

        async with session_factory() as session:
            await mark_analysis_failed(
                session, analysis_id, {"Error": "States.ALL", "Cause": "generic catch-all cause"}
            )

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.errorMessage == "original, more specific reason"
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


def test_run_comparison_crew_handler_returns_immediately_without_waiting_on_the_crew():
    # M5-T3: this handler's own contract is to launch the crew task (a
    # background thread standing in for a real Fargate launch, see
    # crew_task.py's docstring) and return right away — it must not block on
    # the crew actually finishing. A nonexistent analysisId is enough to
    # prove this: if the handler waited on the background work, it would
    # surface CrewTaskError (Analysis not found) instead of returning
    # cleanly. The crew's own success/failure behavior (run_crew_task) is
    # covered by test_crew_task.py and test_workflow_e2e.py.
    result = run_comparison_crew_handler({"analysisId": "abc", "taskToken": "tok"})
    assert result == {"analysisId": "abc", "launched": True}
