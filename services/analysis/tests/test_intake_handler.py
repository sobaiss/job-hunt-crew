import uuid
from datetime import UTC, datetime

import pytest
from py_db.models import Analysis, Analysisstatus, CVVersion, Cvfiletype, Cvparsestatus, JobOffer, Jobofferextractionstatus, Joboffersourcesite, User
from py_db.session import make_engine, make_session_factory

from analysis.intake_handler import IntakeError, start_analysis_workflow


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class StubSfnClient:
    def __init__(self, execution_arn: str):
        self._execution_arn = execution_arn
        self.start_execution_calls = []

    def start_execution(self, **kwargs):
        self.start_execution_calls.append(kwargs)
        return {"executionArn": self._execution_arn}


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
async def test_start_analysis_workflow_records_execution_arn_and_queues():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    stub_client = StubSfnClient(execution_arn="arn:aws:states:us-east-1:1:execution:AnalysisWorkflow:x")

    try:
        async with session_factory() as session:
            arn = await start_analysis_workflow(
                session,
                analysis_id,
                sfn_client=stub_client,
                state_machine_arn="arn:aws:states:us-east-1:1:stateMachine:AnalysisWorkflow",
            )
        assert arn == "arn:aws:states:us-east-1:1:execution:AnalysisWorkflow:x"
        assert len(stub_client.start_execution_calls) == 1
        call = stub_client.start_execution_calls[0]
        assert call["stateMachineArn"] == "arn:aws:states:us-east-1:1:stateMachine:AnalysisWorkflow"
        assert analysis_id in call["input"]

        async with session_factory() as session:
            reloaded = await session.get(Analysis, analysis_id)
            assert reloaded.status == Analysisstatus.QUEUED
            assert reloaded.stepFunctionExecutionArn == "arn:aws:states:us-east-1:1:execution:AnalysisWorkflow:x"
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)


@pytest.mark.asyncio
async def test_start_analysis_workflow_raises_when_analysis_missing():
    engine = make_engine()
    session_factory = make_session_factory(engine)
    stub_client = StubSfnClient(execution_arn="unused")
    try:
        async with session_factory() as session:
            with pytest.raises(IntakeError):
                await start_analysis_workflow(
                    session,
                    "does-not-exist",
                    sfn_client=stub_client,
                    state_machine_arn="arn:aws:states:us-east-1:1:stateMachine:AnalysisWorkflow",
                )
        assert stub_client.start_execution_calls == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_start_analysis_workflow_raises_when_state_machine_arn_not_configured(monkeypatch):
    monkeypatch.delenv("ANALYSIS_WORKFLOW_STATE_MACHINE_ARN", raising=False)
    engine = make_engine()
    session_factory = make_session_factory(engine)
    user_id, job_offer_id, cv_version_id, analysis_id = (
        f"test-user-{uuid.uuid4()}",
        f"test-offer-{uuid.uuid4()}",
        f"test-cv-{uuid.uuid4()}",
        f"test-analysis-{uuid.uuid4()}",
    )
    await _make_fixture(session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
    stub_client = StubSfnClient(execution_arn="unused")

    try:
        async with session_factory() as session:
            with pytest.raises(IntakeError):
                await start_analysis_workflow(session, analysis_id, sfn_client=stub_client)
        assert stub_client.start_execution_calls == []
    finally:
        await _cleanup(engine, session_factory, user_id, job_offer_id, cv_version_id, analysis_id)
