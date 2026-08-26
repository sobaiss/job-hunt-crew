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


def make_sqs_client():
    return boto3.client(
        "sqs",
        endpoint_url=os.environ.get("SQS_ENDPOINT") or None,
        region_name=os.environ.get("SQS_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("SQS_ACCESS_KEY_ID") or None,
        aws_secret_access_key=os.environ.get("SQS_SECRET_ACCESS_KEY") or None,
    )
