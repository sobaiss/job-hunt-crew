"""Unit tests for the local SQS worker (ingestion.local_worker).

Hermetic — a FakeSqs stands in for ElasticMQ (the same pattern
test_analysis_fanout.py / test_ingestion_intake.py use for the producer side),
so these need neither the docker-compose infra nor the DB.
"""

import json

import pytest

from ingestion import local_worker
from ingestion.local_worker import (
    QUEUE_SPECS,
    QueueSpec,
    UnknownAnalysisModeError,
    UnknownQueueError,
    _resolve_scout_schedule_tick,
    drain,
    poll_once,
    resolve_analysis_intake_handler_ref,
    resolve_queue_names,
    run_forever,
)


class FakeSqs:
    """Yields one batch per queue then reports empty. Records every delete."""

    def __init__(self, batches: dict[str, list[list[dict]]] | None = None):
        # queue_url -> list of batches still to hand out
        self._batches = batches or {}
        self.deleted: list[str] = []
        self.receive_calls: list[str] = []

    def receive_message(self, *, QueueUrl, MaxNumberOfMessages, WaitTimeSeconds):
        self.receive_calls.append(QueueUrl)
        pending = self._batches.get(QueueUrl, [])
        if not pending:
            return {}
        return {"Messages": pending.pop(0)}

    def delete_message_batch(self, *, QueueUrl, Entries):
        self.deleted.extend(e["ReceiptHandle"] for e in Entries)
        return {"Successful": [{"Id": e["Id"]} for e in Entries], "Failed": []}


def _msg(message_id: str, body: dict) -> dict:
    return {
        "MessageId": message_id,
        "ReceiptHandle": f"rh-{message_id}",
        "Body": json.dumps(body),
    }


# --- resolve_queue_names ---------------------------------------------------


def test_resolve_queue_names_defaults_to_every_queue():
    assert resolve_queue_names(None) == list(QUEUE_SPECS)
    assert resolve_queue_names("   ") == list(QUEUE_SPECS)


def test_resolve_queue_names_selects_and_orders_the_given_subset():
    assert resolve_queue_names("ingestion-intake, cv-conversion") == [
        "ingestion-intake",
        "cv-conversion",
    ]


def test_resolve_queue_names_dedupes():
    assert resolve_queue_names("cv-conversion,cv-conversion") == ["cv-conversion"]


def test_resolve_queue_names_rejects_an_unknown_queue():
    with pytest.raises(UnknownQueueError):
        resolve_queue_names("cv-conversion,not-a-queue")


# --- resolve_analysis_intake_handler_ref -------------------------------------


def test_analysis_intake_handler_defaults_to_the_in_process_local_runner():
    ref = "analysis.local_pipeline:handle_analysis_intake_local"
    assert resolve_analysis_intake_handler_ref(None) == ref
    assert resolve_analysis_intake_handler_ref("  ") == ref
    assert resolve_analysis_intake_handler_ref("LOCAL") == ref
    # ...and that is what the registered QueueSpec uses out of the box.
    assert QUEUE_SPECS["analysis-intake"].handler_ref == ref


def test_analysis_intake_handler_stepfunctions_mode_selects_the_workflow_starter():
    assert (
        resolve_analysis_intake_handler_ref("stepfunctions")
        == "analysis.intake_handler:handle_analysis_intake"
    )


def test_analysis_intake_handler_rejects_an_unknown_mode():
    with pytest.raises(UnknownAnalysisModeError):
        resolve_analysis_intake_handler_ref("sqs-lambda")


# --- poll_once -----------------------------------------------------------------


def test_poll_once_returns_zero_and_does_not_call_the_handler_when_empty():
    calls: list[dict] = []
    spec = QUEUE_SPECS["cv-conversion"]

    processed = poll_once(FakeSqs(), spec, handler=calls.append)

    assert processed == 0
    assert calls == []


def test_poll_once_wraps_the_batch_as_an_event_and_deletes_on_success():
    spec = QUEUE_SPECS["cv-conversion"]
    batch = [_msg("1", {"cvVersionId": "cv-1"}), _msg("2", {"cvVersionId": "cv-2"})]
    fake = FakeSqs({spec.queue_url: [batch]})
    seen: list[dict] = []

    processed = poll_once(fake, spec, handler=seen.append)

    assert processed == 2
    assert seen == [
        {
            "Records": [
                {
                    "messageId": "1",
                    "receiptHandle": "rh-1",
                    "body": json.dumps({"cvVersionId": "cv-1"}),
                },
                {
                    "messageId": "2",
                    "receiptHandle": "rh-2",
                    "body": json.dumps({"cvVersionId": "cv-2"}),
                },
            ]
        }
    ]
    assert fake.deleted == ["rh-1", "rh-2"]


def test_poll_once_leaves_the_batch_undeleted_when_the_handler_raises():
    spec = QUEUE_SPECS["cv-conversion"]
    fake = FakeSqs({spec.queue_url: [[_msg("1", {"cvVersionId": "cv-1"})]]})

    def boom(_event):
        raise RuntimeError("handler blew up")

    processed = poll_once(fake, spec, handler=boom)

    assert processed == 0
    assert fake.deleted == []


def test_poll_once_resolves_the_registered_handler_lazily(monkeypatch):
    """With no explicit handler, poll_once imports `spec.handler_ref` at call
    time — so monkeypatching the target symbol is enough to intercept it."""
    seen: list[dict] = []
    monkeypatch.setattr(
        "analysis.cv_conversion.handle_cv_conversion", seen.append, raising=True
    )
    spec = QUEUE_SPECS["cv-conversion"]
    fake = FakeSqs({spec.queue_url: [[_msg("1", {"cvVersionId": "cv-1"})]]})

    processed = poll_once(fake, spec)

    assert processed == 1
    assert seen and seen[0]["Records"][0]["body"] == json.dumps({"cvVersionId": "cv-1"})
    assert fake.deleted == ["rh-1"]


# --- drain -------------------------------------------------------------------


def _noop_handler_for_every_spec(monkeypatch):
    # QueueSpec is a frozen dataclass, so patch the method on the class.
    monkeypatch.setattr(QueueSpec, "handler", lambda self: (lambda _event: None))


def test_drain_loops_each_queue_until_it_is_empty(monkeypatch):
    _noop_handler_for_every_spec(monkeypatch)
    spec = QUEUE_SPECS["cv-conversion"]
    fake = FakeSqs(
        {spec.queue_url: [[_msg("1", {"cvVersionId": "a"})], [_msg("2", {"cvVersionId": "b"})]]}
    )

    totals = drain(["cv-conversion"], sqs=fake)

    assert totals == {"cv-conversion": 2}
    assert fake.deleted == ["rh-1", "rh-2"]
    # empty poll after the two batches, then stop
    assert fake.receive_calls.count(spec.queue_url) == 3


def test_drain_only_touches_the_named_queues(monkeypatch):
    _noop_handler_for_every_spec(monkeypatch)
    fake = FakeSqs()

    drain(["analysis-intake"], sqs=fake)

    assert set(fake.receive_calls) == {QUEUE_SPECS["analysis-intake"].queue_url}


# --- run_forever -------------------------------------------------------------


def test_run_forever_polls_selected_queues_then_stops_on_the_event(monkeypatch):
    import threading

    stop = threading.Event()
    polled: list[str] = []

    def fake_poll_once(_sqs, spec, handler=None):
        polled.append(spec.name)
        stop.set()  # one sweep is enough
        return 0

    monkeypatch.setattr(local_worker, "poll_once", fake_poll_once)

    run_forever(["cv-conversion", "analysis-intake"], sqs=FakeSqs(), stop=stop)

    assert polled == ["cv-conversion"]


def test_run_forever_keeps_going_after_a_transport_error(monkeypatch):
    import threading

    stop = threading.Event()
    attempts: list[str] = []

    def flaky_poll_once(_sqs, spec, handler=None):
        attempts.append(spec.name)
        if len(attempts) == 1:
            raise ConnectionError("elasticmq not ready")
        stop.set()
        return 0

    monkeypatch.setattr(local_worker, "poll_once", flaky_poll_once)

    run_forever(["cv-conversion"], sqs=FakeSqs(), stop=stop)

    assert attempts == ["cv-conversion", "cv-conversion"]


# --- scout-schedule tick (issue #57) -----------------------------------------


def test_resolve_scout_schedule_tick_is_none_without_scout_intake():
    assert _resolve_scout_schedule_tick(["cv-conversion", "analysis-intake"]) is None


def test_resolve_scout_schedule_tick_resolves_the_scheduler_when_selected(monkeypatch):
    sentinel = object()
    monkeypatch.setattr("scout.schedule.run_scheduler_tick_once", lambda: sentinel, raising=True)

    tick = _resolve_scout_schedule_tick(["scout-intake"])

    assert tick() is sentinel


def test_run_forever_fires_on_tick_on_the_first_sweep(monkeypatch):
    import threading

    stop = threading.Event()
    ticks: list[None] = []

    def fake_poll_once(_sqs, spec, handler=None):
        stop.set()
        return 0

    monkeypatch.setattr(local_worker, "poll_once", fake_poll_once)

    run_forever(
        ["scout-intake"],
        sqs=FakeSqs(),
        stop=stop,
        on_tick=lambda: ticks.append(None),
        tick_interval_seconds=3600,
    )

    assert ticks == [None]


def test_run_forever_does_not_fire_on_tick_again_before_the_interval_elapses(monkeypatch):
    import threading

    stop = threading.Event()
    ticks: list[None] = []
    sweeps = {"n": 0}

    def fake_poll_once(_sqs, spec, handler=None):
        sweeps["n"] += 1
        if sweeps["n"] >= 2:
            stop.set()
        return 0

    monkeypatch.setattr(local_worker, "poll_once", fake_poll_once)

    run_forever(
        ["scout-intake"],
        sqs=FakeSqs(),
        stop=stop,
        on_tick=lambda: ticks.append(None),
        tick_interval_seconds=3600,
    )

    # Two sweeps happen well within the (mocked long) interval, so the tick
    # fires once, on the first sweep, not again on the second.
    assert ticks == [None]


def test_run_forever_tick_exception_is_logged_and_does_not_stop_the_loop(monkeypatch):
    import threading

    stop = threading.Event()

    def fake_poll_once(_sqs, spec, handler=None):
        stop.set()
        return 0

    monkeypatch.setattr(local_worker, "poll_once", fake_poll_once)

    def boom():
        raise RuntimeError("tick blew up")

    # No exception propagates out of run_forever.
    run_forever(
        ["scout-intake"], sqs=FakeSqs(), stop=stop, on_tick=boom, tick_interval_seconds=3600
    )
