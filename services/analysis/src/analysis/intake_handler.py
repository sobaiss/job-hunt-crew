"""SQS-triggered AnalysisWorkflow intake (PRD Section 10 step 3, M5-T2).

Consumes the `analysis-intake` SQS messages M5-T1's `POST /api/analyses`
enqueues, starts a Step Functions execution of the AnalysisWorkflow state
machine (M5-T2's state_machine module) for each, and records the resulting
execution ARN on the Analysis row: "SQS-triggered Step Functions execution
(AnalysisWorkflow) starts; Analysis.status -> QUEUED,
stepFunctionExecutionArn recorded."
"""

import asyncio
import json
import os

from py_db.models import Analysis, Analysisstatus
from py_db.session import make_engine, make_session_factory
from sqlalchemy.ext.asyncio import AsyncSession

from .state_machine import make_sfn_client

STATE_MACHINE_ARN_ENV = "ANALYSIS_WORKFLOW_STATE_MACHINE_ARN"


class IntakeError(Exception):
    pass


async def start_analysis_workflow(
    session: AsyncSession,
    analysis_id: str,
    *,
    sfn_client=None,
    state_machine_arn: str | None = None,
    execution_name: str | None = None,
) -> str:
    """Starts a Step Functions execution of the AnalysisWorkflow for
    `analysis_id`, then transitions Analysis.status PENDING -> QUEUED and
    records the execution ARN. Returns the execution ARN.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise IntakeError(f"Analysis {analysis_id} not found")

    client = sfn_client or make_sfn_client()
    arn = state_machine_arn or os.environ.get(STATE_MACHINE_ARN_ENV)
    if not arn:
        raise IntakeError(f"{STATE_MACHINE_ARN_ENV} is not configured")

    response = client.start_execution(
        stateMachineArn=arn,
        name=execution_name or f"analysis-{analysis_id}",
        input=json.dumps({"analysisId": analysis_id}),
    )

    analysis.status = Analysisstatus.QUEUED
    analysis.stepFunctionExecutionArn = response["executionArn"]
    await session.commit()
    return response["executionArn"]


def handle_analysis_intake(event: dict, context=None) -> None:
    """SQS event-source-mapping Lambda entrypoint: `event["Records"]` is a
    batch of `analysis-intake` messages, each with a JSON body
    `{"analysisId": "..."}` (per M5-T1's POST /api/analyses).
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    body = json.loads(record["body"])
                    await start_analysis_workflow(session, body["analysisId"])
        finally:
            await engine.dispose()

    asyncio.run(_run())
