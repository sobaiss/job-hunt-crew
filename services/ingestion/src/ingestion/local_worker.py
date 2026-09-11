"""Local stand-in for the AWS SQS -> Lambda event-source mappings (dev only).

Four queues carry work into the async pipeline — `cv-conversion`,
`analysis-intake`, `ingestion-intake`, `scout-intake` — each drained in
production by an SQS event-source mapping that invokes a Lambda
(`handle_cv_conversion`, `handle_analysis_intake`, `handle_ingestion_intake`,
`handle_scout_intake`). That wiring is AWS infra,
out of scope per PRD Section 4/15, so nothing drains those queues locally: a
"Convert to Markdown" click or a submitted IngestionJob just parks a message in
ElasticMQ and the row never leaves PENDING.

This module is the local equivalent of what `analysis.lambda_shim` does for the
Step Functions Lambda invoke API: a plain polling loop that receives from each
selected queue, wraps the messages in the `{"Records": [...]}` shape the real
event-source mapping produces, calls the same handler, and deletes the messages
on success. A handler that raises leaves its batch un-deleted for ElasticMQ to
redeliver after the visibility timeout, exactly as SQS would.

It lives in `services/ingestion` because that is the only workspace package able
to import both `ingestion.*` and `analysis.*` (ingestion depends on analysis,
not the reverse).

Run it via `make worker` (host) or the `worker` service in docker-compose.yml.
`WORKER_QUEUES` (comma-separated queue names) selects which subset to drain; the
compose service drains all four (`cv-conversion`, `ingestion-intake`,
`analysis-intake`, `scout-intake`), so "Convert to Markdown", "Analyse one
offer", "Analyse several offers" and a Scout "Run now" all complete on their
own after `docker compose up`.
`WORKER_RUN_ONCE=1` drains what is currently queued and exits.

`analysis-intake` has two drainers, chosen by `WORKER_ANALYSIS_MODE`:
- `local` (default): `analysis.local_pipeline.handle_analysis_intake_local`
  runs the whole AnalysisWorkflow in-process (the same shape `cv-conversion`
  uses) — no `stepfunctions-local` / `lambda_shim` / registered state machine
  needed, so it works straight after `docker compose up`.
- `stepfunctions`: `analysis.intake_handler.handle_analysis_intake` starts a
  real Step Functions Local execution — the production-shaped path, needing the
  host `lambda_shim`, a Step Functions execution, and `SFN_*` env. Use it to
  exercise the state machine itself.
"""

import os
import signal
import threading
from collections.abc import Callable
from dataclasses import dataclass
from importlib import import_module

from py_db.structured_logging import get_logger

from .sqs_client import make_sqs_client

logger = get_logger(__name__)

Handler = Callable[[dict], None]

# SQS long-poll wait per receive_message call (SQS caps this at 20s).
WAIT_SECONDS = int(os.environ.get("WORKER_WAIT_SECONDS", "5"))
MAX_MESSAGES = 10

_DEFAULT_QUEUE_BASE = "http://localhost:9324/000000000000"

# `analysis-intake` drainers, keyed by WORKER_ANALYSIS_MODE (see module docstring).
_ANALYSIS_INTAKE_HANDLER_REFS: dict[str, str] = {
    "local": "analysis.local_pipeline:handle_analysis_intake_local",
    "stepfunctions": "analysis.intake_handler:handle_analysis_intake",
}
DEFAULT_ANALYSIS_MODE = "local"


class UnknownAnalysisModeError(ValueError):
    pass


def resolve_analysis_intake_handler_ref(raw: str | None) -> str:
    """`module:attr` for the `analysis-intake` handler `WORKER_ANALYSIS_MODE`
    selects. Blank / unset -> the in-process `local` runner. An unrecognised
    mode is a hard error rather than a silent fallback.
    """
    mode = (raw or DEFAULT_ANALYSIS_MODE).strip().lower() or DEFAULT_ANALYSIS_MODE
    try:
        return _ANALYSIS_INTAKE_HANDLER_REFS[mode]
    except KeyError:
        raise UnknownAnalysisModeError(
            f"Unknown WORKER_ANALYSIS_MODE {mode!r}; known modes: "
            f"{list(_ANALYSIS_INTAKE_HANDLER_REFS)}"
        ) from None


@dataclass(frozen=True)
class QueueSpec:
    name: str
    queue_url: str
    # "module:attr" — imported lazily so queue selection / --once parsing needs
    # no heavy handler deps, and tests can monkeypatch the symbol.
    handler_ref: str

    def handler(self) -> Handler:
        module_name, attr = self.handler_ref.split(":")
        return getattr(import_module(module_name), attr)


def _queue_url(name: str, env_var: str) -> str:
    return os.environ.get(env_var, f"{_DEFAULT_QUEUE_BASE}/{name}")


# Registry: queue name -> its URL (env var names match the producers in
# services/api/src/api/sqs_client.py and services/ingestion/src/ingestion/
# sqs_client.py so both sides agree) + the handler that drains it.
QUEUE_SPECS: dict[str, QueueSpec] = {
    "cv-conversion": QueueSpec(
        "cv-conversion",
        _queue_url("cv-conversion", "SQS_CV_CONVERSION_QUEUE_URL"),
        "analysis.cv_conversion:handle_cv_conversion",
    ),
    "analysis-intake": QueueSpec(
        "analysis-intake",
        _queue_url("analysis-intake", "SQS_ANALYSIS_INTAKE_QUEUE_URL"),
        resolve_analysis_intake_handler_ref(os.environ.get("WORKER_ANALYSIS_MODE")),
    ),
    "ingestion-intake": QueueSpec(
        "ingestion-intake",
        _queue_url("ingestion-intake", "SQS_INGESTION_INTAKE_QUEUE_URL"),
        "ingestion.intake_handler:handle_ingestion_intake",
    ),
    "scout-intake": QueueSpec(
        "scout-intake",
        _queue_url("scout-intake", "SQS_SCOUT_INTAKE_QUEUE_URL"),
        "scout.intake_handler:handle_scout_intake",
    ),
}

ALL_QUEUES: tuple[str, ...] = tuple(QUEUE_SPECS)


class UnknownQueueError(ValueError):
    pass


def resolve_queue_names(raw: str | None) -> list[str]:
    """Parse `WORKER_QUEUES` (comma-separated). Blank / unset -> every queue.
    An unrecognised name is a hard error rather than a silent no-op. Order is
    preserved and duplicates are dropped.
    """
    if raw is None or not raw.strip():
        return list(ALL_QUEUES)
    names = [part.strip() for part in raw.split(",") if part.strip()]
    unknown = [n for n in names if n not in QUEUE_SPECS]
    if unknown:
        raise UnknownQueueError(
            f"Unknown WORKER_QUEUES entries {unknown}; known queues: {list(ALL_QUEUES)}"
        )
    deduped: dict[str, None] = {}
    for n in names:
        deduped.setdefault(n, None)
    return list(deduped)


def _wrap_as_event(messages: list[dict]) -> dict:
    """The subset of an SQS event-source-mapping event the handlers read
    (`record["body"]`), plus the ids a real record carries."""
    return {
        "Records": [
            {
                "messageId": m["MessageId"],
                "receiptHandle": m["ReceiptHandle"],
                "body": m["Body"],
            }
            for m in messages
        ]
    }


def poll_once(sqs, spec: QueueSpec, handler: Handler | None = None) -> int:
    """One receive -> handle -> delete cycle for a single queue. Returns the
    number of messages processed (0 when the queue was empty). On a handler
    exception the batch is left un-deleted so ElasticMQ redelivers it after the
    visibility timeout, exactly as SQS would.
    """
    resp = sqs.receive_message(
        QueueUrl=spec.queue_url,
        MaxNumberOfMessages=MAX_MESSAGES,
        WaitTimeSeconds=WAIT_SECONDS,
    )
    messages = resp.get("Messages", [])
    if not messages:
        return 0

    run = handler or spec.handler()
    logger.info(
        "worker.received",
        extra={"fields": {"queue": spec.name, "count": len(messages)}},
    )
    try:
        run(_wrap_as_event(messages))
    except Exception:
        logger.exception(
            "worker.handler_failed queue=%s (batch left for redelivery)", spec.name
        )
        return 0

    sqs.delete_message_batch(
        QueueUrl=spec.queue_url,
        Entries=[
            {"Id": str(i), "ReceiptHandle": m["ReceiptHandle"]}
            for i, m in enumerate(messages)
        ],
    )
    logger.info(
        "worker.processed",
        extra={"fields": {"queue": spec.name, "count": len(messages)}},
    )
    return len(messages)


def drain(queue_names: list[str], *, sqs=None) -> dict[str, int]:
    """Process every message currently on each named queue, then return
    per-queue counts. Backs `WORKER_RUN_ONCE=1` and `make worker-once`.
    """
    client = sqs or make_sqs_client()
    totals: dict[str, int] = {}
    for name in queue_names:
        spec = QUEUE_SPECS[name]
        count = 0
        while True:
            processed = poll_once(client, spec)
            if processed == 0:
                break
            count += processed
        totals[name] = count
    return totals


def run_forever(
    queue_names: list[str], *, sqs=None, stop: threading.Event | None = None
) -> None:
    """Poll each selected queue in turn until `stop` is set. A transport error
    talking to ElasticMQ is logged and the loop continues (the queue is still
    there once it recovers).
    """
    client = sqs or make_sqs_client()
    specs = [QUEUE_SPECS[n] for n in queue_names]
    stop = stop or threading.Event()
    logger.info(
        "worker.start",
        extra={"fields": {"queues": queue_names, "wait_seconds": WAIT_SECONDS}},
    )
    while not stop.is_set():
        for spec in specs:
            if stop.is_set():
                break
            try:
                poll_once(client, spec)
            except Exception:
                logger.exception("worker.poll_failed queue=%s", spec.name)
    logger.info("worker.stop", extra={"fields": {"queues": queue_names}})


def main() -> int:
    queue_names = resolve_queue_names(os.environ.get("WORKER_QUEUES"))

    if os.environ.get("WORKER_RUN_ONCE"):
        totals = drain(queue_names)
        logger.info("worker.drained", extra={"fields": {"totals": totals}})
        return 0

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    run_forever(queue_names, stop=stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
