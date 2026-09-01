# Built with the repo root as build context (uv workspace: services/ingestion
# depends on services/analysis and packages/py-db as workspace members, and uv
# needs every member's pyproject.toml present to resolve against the shared
# root uv.lock). Mirrors services/api/Dockerfile.
#
# Runs ingestion.local_worker — the local stand-in for the AWS SQS -> Lambda
# event-source mappings that drain the pipeline's queues. See the `worker`
# service in docker-compose.yml.
FROM python:3.11-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY . .

RUN uv sync --frozen --package ingestion

CMD ["uv", "run", "--package", "ingestion", "python", "-m", "ingestion.local_worker"]
