import os

import boto3

# Local dev points at the docker-compose ElasticMQ emulator (see
# elasticmq.conf), which pre-declares this queue; real AWS SQS would have
# this created via IaC (out of scope per PRD Section 4/15) and referenced by
# its actual queue URL here instead. Mirrors apps/web/lib/sqs.ts's env var
# names so both sides of the M7 migration agree on the same queue.
ANALYSIS_INTAKE_QUEUE_URL = os.environ.get(
    "SQS_ANALYSIS_INTAKE_QUEUE_URL", "http://localhost:9324/000000000000/analysis-intake"
)

# The manual "Convert to Markdown" trigger (POST /v1/cv-versions/{id}/convert)
# enqueues here; services/analysis's handle_cv_conversion consumer drains it and
# runs the same convert_cv the AnalysisWorkflow prerequisite uses.
CV_CONVERSION_QUEUE_URL = os.environ.get(
    "SQS_CV_CONVERSION_QUEUE_URL", "http://localhost:9324/000000000000/cv-conversion"
)

# POST /v1/ingestion-jobs enqueues `{"ingestionJobId": id}` here for both
# SINGLE_URL and SITE_SEARCH modes; the ingestion-intake worker (issue #27)
# loads the IngestionJob, runs the discover/scrape/extract pipeline, and
# creates one Analysis per ready JobOffer. Mirrors ANALYSIS_INTAKE_QUEUE_URL.
INGESTION_INTAKE_QUEUE_URL = os.environ.get(
    "SQS_INGESTION_INTAKE_QUEUE_URL", "http://localhost:9324/000000000000/ingestion-intake"
)

# POST /v1/scouts/{id}/run (and, from slice 5, the daily scheduler tick)
# enqueues `{"scoutRunId": id}` here; the scout-intake worker loads the
# ScoutRun and fans out one SITE_SEARCH IngestionJob per targeted site.
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
