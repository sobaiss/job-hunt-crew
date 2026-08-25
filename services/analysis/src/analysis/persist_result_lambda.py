"""PersistResultLambda (PRD Section 10 steps 8-9, M5-T4).

S3 `ObjectCreated` event handler for `analysis-results/` keys written by
M5-T3's Fargate task (`crew_task.run_crew_task`). Reads the S3 object,
re-validates it against the Section 8.6 `AnalysisResult` schema (Section
8.6 requires validation "again before Postgres persistence" — `crew_task`
already validates before writing to S3, this is the second, independent
gate), and upserts `resultJSON`/`matchScore`, setting
`status=COMPLETED`/`completedAt=now()`. Per PRD Section 10 step 9, this is
the sole writer of terminal Analysis state — unlike M2-T6's
`comparison_crew.run_analysis` (M2's simplified direct-write path) and
M5-T3's `run_crew_task`, which deliberately stops at AWAITING_RESULT.

Wiring the real S3 `ObjectCreated` -> Lambda trigger (an S3 bucket
notification configuration) is deployment/infra provisioning, out of PRD
scope — same boundary already drawn for the SQS trigger in
`intake_handler` and the Step Functions Task launch in `handlers`.
"""

import asyncio
import json
from datetime import UTC, datetime

from py_db.models import Analysis, Analysisstatus
from py_db.session import make_engine, make_session_factory
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from .analysis_result import AnalysisResult
from .s3_client import S3_BUCKET, analysis_result_key, make_s3_client

ANALYSIS_RESULTS_PREFIX = "analysis-results/"


class PersistResultError(Exception):
    pass


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def analysis_id_from_key(key: str) -> str:
    if not key.startswith(ANALYSIS_RESULTS_PREFIX) or not key.endswith(".json"):
        raise PersistResultError(f"Unexpected analysis-results object key: {key}")
    return key[len(ANALYSIS_RESULTS_PREFIX) : -len(".json")]


async def persist_analysis_result(
    session: AsyncSession,
    analysis_id: str,
    *,
    s3_client=None,
    bucket: str | None = None,
    key: str | None = None,
) -> Analysis:
    """Reads the analysis-results S3 object for `analysis_id`, validates it
    against the Section 8.6 schema, and upserts the terminal Analysis state.
    On a missing/malformed object, transitions Analysis to FAILED with a
    non-empty errorMessage instead of a silent or partial write, then raises
    PersistResultError.
    """
    analysis = await session.get(Analysis, analysis_id)
    if analysis is None:
        raise PersistResultError(f"Analysis {analysis_id} not found")

    s3 = s3_client or make_s3_client()
    resolved_key = key or analysis.s3ResultKey or analysis_result_key(analysis_id)

    try:
        obj = s3.get_object(Bucket=bucket or S3_BUCKET, Key=resolved_key)
        payload = json.loads(obj["Body"].read())
        result = AnalysisResult.model_validate(payload)
    except (json.JSONDecodeError, ValidationError) as exc:
        message = f"analysis-results object at {resolved_key} failed schema validation: {exc}"
        analysis.status = Analysisstatus.FAILED
        analysis.errorMessage = message
        await session.commit()
        raise PersistResultError(message) from exc

    analysis.resultJSON = result.model_dump(mode="json")
    analysis.matchScore = result.match_score
    analysis.status = Analysisstatus.COMPLETED
    analysis.errorMessage = None
    analysis.completedAt = _now()
    await session.commit()
    return analysis


def handle_analysis_result_created(event: dict, context=None) -> None:
    """S3 `ObjectCreated`-triggered Lambda entrypoint: `event["Records"]` is
    a batch of S3 event notification records (real AWS shape), each with
    `s3.bucket.name` / `s3.object.key` identifying one written
    `analysis-results/{analysisId}.json` object.
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    bucket = record["s3"]["bucket"]["name"]
                    key = record["s3"]["object"]["key"]
                    analysis_id = analysis_id_from_key(key)
                    await persist_analysis_result(session, analysis_id, bucket=bucket, key=key)
        finally:
            await engine.dispose()

    asyncio.run(_run())
