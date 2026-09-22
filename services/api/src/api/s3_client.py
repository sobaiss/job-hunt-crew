import os

import boto3
from botocore.client import Config

S3_BUCKET = os.environ.get("S3_BUCKET", "job-hunt-crew")


def _client(endpoint: str | None):
    force_path_style = os.environ.get("S3_FORCE_PATH_STYLE") == "true"
    return boto3.client(
        "s3",
        endpoint_url=endpoint or None,
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID") or None,
        aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY") or None,
        config=Config(s3={"addressing_style": "path"}) if force_path_style else None,
    )


def make_s3_client():
    """For presigned URLs only. `generate_presigned_url` performs no network
    I/O — it only signs a URL with this endpoint baked in as the host — so
    this must be the *browser*-reachable address (docker-compose.yml). Any
    call this process itself needs to make over the network (delete_object,
    head_object, ...) must use `make_internal_s3_client` instead: local
    MinIO needs a different, docker-network address for that, one the
    browser could never resolve.
    """
    return _client(os.environ.get("S3_ENDPOINT"))


def make_internal_s3_client():
    """For real, server-side S3 calls this process makes over the network
    (delete_object, head_object, ...) — unlike `make_s3_client`, this needs
    an endpoint *this process* can reach, not one the browser can. Falls
    back to S3_ENDPOINT so a single-endpoint setup (real AWS S3, or anything
    without local MinIO's browser-vs-container split) works unchanged;
    S3_INTERNAL_ENDPOINT only needs setting where that split exists (local
    dev — docker-compose.yml).
    """
    return _client(os.environ.get("S3_INTERNAL_ENDPOINT") or os.environ.get("S3_ENDPOINT"))


def cv_file_key(user_id: str, cv_version_id: str, file_name: str) -> str:
    return f"cvs/{user_id}/{cv_version_id}/{file_name}"
