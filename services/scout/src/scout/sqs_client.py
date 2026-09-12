import os

import boto3

# A Scout run fans out by creating one SITE_SEARCH IngestionJob per targeted
# site and enqueuing `{"ingestionJobId": id}` here — the same queue
# `POST /v1/ingestion-jobs` uses, drained by the ingestion-intake worker.
# Env var name matches services/api + services/ingestion so all sides agree.
INGESTION_INTAKE_QUEUE_URL = os.environ.get(
    "SQS_INGESTION_INTAKE_QUEUE_URL", "http://localhost:9324/000000000000/ingestion-intake"
)

# `POST /v1/scouts/{id}/run` and the daily scheduler tick enqueue
# `{"scoutRunId": id}` here; the scout-intake worker drains it and calls
# `dispatch_scout_run`.
SCOUT_INTAKE_QUEUE_URL = os.environ.get(
    "SQS_SCOUT_INTAKE_QUEUE_URL", "http://localhost:9324/000000000000/scout-intake"
)


def make_sqs_client():
    return boto3.client(
        "sqs",
        endpoint_url=os.environ.get("SQS_ENDPOINT") or None,
        region_name=os.environ.get("SQS_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("SQS_ACCESS_KEY_ID") or None,
        aws_secret_access_key=os.environ.get("SQS_SECRET_ACCESS_KEY") or None,
    )
