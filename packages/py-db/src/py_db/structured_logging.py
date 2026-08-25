"""Structured (JSON) logging for the Lambda/Fargate pipeline steps (M6-T3).

A single JSON-lines formatter shared by services/ingestion and
services/analysis so every step's logs are machine-parseable the same way
regardless of which service emits them, matching PRD Section 11's
"structured logs across Lambda/Fargate steps" requirement.
"""

import json
import logging
import sys
from datetime import UTC, datetime

_CONFIGURED = False


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "fields", None)
        if extra:
            payload.update(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def get_logger(name: str) -> logging.Logger:
    """Returns a logger that emits one JSON object per line to stdout. Safe
    to call repeatedly (e.g. once per module import) — configures the root
    handler only once per process.
    """
    global _CONFIGURED
    if not _CONFIGURED:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        root = logging.getLogger()
        root.addHandler(handler)
        root.setLevel(logging.INFO)
        _CONFIGURED = True
    return logging.getLogger(name)


def log_stage_event(
    logger: logging.Logger,
    *,
    stage: str,
    status: str,
    message: str | None = None,
    **fields: object,
) -> None:
    """Logs one pipeline-stage transition with `stage`/`status` (and any
    extra identifying fields, e.g. analysis_id/ingestion_job_id) as
    structured fields on the JSON line, mirroring what's written to
    PipelineEvent (pipeline_events.record_pipeline_event) for the same
    transition.
    """
    logger.info(
        message or f"{stage}.{status.lower()}",
        extra={"fields": {"stage": stage, "status": status, **fields}},
    )
