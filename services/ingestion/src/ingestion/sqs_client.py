import os

import boto3

# The end-of-fan-out Analysis-creation step (issue #27) enqueues
# `{"analysisId": id}` here for each READY JobOffer, and the existing
# services/analysis `handle_analysis_intake` consumer drains it exactly as it
# does for `POST /v1/analyses`. Mirrors services/api/src/api/sqs_client.py's
# env var name so both producers agree on the same queue.
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
