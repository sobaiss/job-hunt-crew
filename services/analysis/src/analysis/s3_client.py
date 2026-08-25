import os

import boto3
from botocore.client import Config

S3_BUCKET = os.environ.get("S3_BUCKET", "job-hunt-crew")


def make_s3_client():
    force_path_style = os.environ.get("S3_FORCE_PATH_STYLE") == "true"
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT") or None,
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID") or None,
        aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY") or None,
        config=Config(s3={"addressing_style": "path"}) if force_path_style else None,
    )


def raw_scrape_key(job_offer_id: str) -> str:
    return f"raw-scrapes/{job_offer_id}.html"


def analysis_result_key(analysis_id: str) -> str:
    return f"analysis-results/{analysis_id}.json"
