"""SQS-triggered `scout-intake` worker (issue #54).

Consumes the `{"scoutRunId": ...}` messages `POST /v1/scouts/{id}/run` (and,
from slice 5, the daily scheduler tick) enqueue, and hands each to
`dispatch_scout_run`. Parallel to `ingestion.intake_handler`.
"""

import asyncio
import json

from py_db.session import make_engine, make_session_factory
from py_db.structured_logging import get_logger

from .dispatch import dispatch_scout_run

logger = get_logger(__name__)


def handle_scout_intake(event: dict, context=None) -> None:
    """SQS event-source-mapping entrypoint: `event["Records"]` is a batch of
    `scout-intake` messages, each with a JSON body `{"scoutRunId": "..."}`. A
    per-record failure is logged and swallowed so one bad message doesn't
    block the batch or redeliver forever.
    """

    async def _run() -> None:
        engine = make_engine()
        session_factory = make_session_factory(engine)
        try:
            async with session_factory() as session:
                for record in event["Records"]:
                    body = json.loads(record["body"])
                    try:
                        await dispatch_scout_run(session, body["scoutRunId"])
                    except Exception:
                        logger.exception(
                            "scout_intake_failed for scout_run_id=%s",
                            body.get("scoutRunId"),
                        )
        finally:
            await engine.dispose()

    asyncio.run(_run())
