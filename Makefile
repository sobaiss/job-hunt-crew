.PHONY: up down migrate seed worker worker-once

# Start local infrastructure (Postgres, MinIO, ElasticMQ, Step Functions
# Local, api, worker). The `migrate` service applies pending Prisma
# migrations before `api` starts — see docker-compose.yml.
up:
	docker compose up -d

down:
	docker compose down

# Re-run migrations against the running compose Postgres without a full
# `docker compose up` (e.g. after pulling new migrations).
migrate:
	pnpm --filter @job-hunt-crew/prisma exec prisma migrate deploy

seed:
	pnpm --filter @job-hunt-crew/prisma exec prisma db seed

# Host env pointing the worker at the running docker-compose infra — the same
# values as the compose `worker` service, but on localhost instead of the
# docker-network hostnames. Without SQS_ENDPOINT set, boto3 falls back to real
# AWS and `make worker` dies with `InvalidAddress ... sqs.us-east-1.amazonaws.com`.
# Inline `VAR=val` overrides only these; WORKER_QUEUES / WORKER_ANALYSIS_MODE /
# LLM_PROVIDER / ANTHROPIC_API_KEY / OLLAMA_BASE_URL still come from your shell.
WORKER_LOCAL_ENV = \
	DATABASE_URL=postgresql://postgres:postgres@localhost:5432/job_hunt_crew \
	SQS_ENDPOINT=http://localhost:9324 SQS_REGION=us-east-1 \
	SQS_ACCESS_KEY_ID=x SQS_SECRET_ACCESS_KEY=x \
	S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_BUCKET=job-hunt-crew \
	S3_FORCE_PATH_STYLE=true S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin \
	SFN_ENDPOINT=http://localhost:8083 SFN_REGION=us-east-1 \
	SFN_ACCESS_KEY_ID=x SFN_SECRET_ACCESS_KEY=x

# Run the local SQS worker on the host against the running compose infra —
# the stand-in for the AWS SQS -> Lambda event-source mappings. Drains ALL
# three pipeline queues by default (override with WORKER_QUEUES=...). The
# compose `worker` service already covers all three (`cv-conversion`,
# `ingestion-intake`, `analysis-intake` — the last in-process,
# WORKER_ANALYSIS_MODE=local) — you only need this on the host to watch worker
# logs directly, or with WORKER_ANALYSIS_MODE=stepfunctions to drive
# `analysis-intake` through the real Step Functions state machine (that mode
# additionally needs the Lambda shim running + a registered state machine +
# ANALYSIS_WORKFLOW_STATE_MACHINE_ARN — see README section 5).
worker:
	$(WORKER_LOCAL_ENV) uv run --package ingestion python -m ingestion.local_worker

# Drain whatever is currently queued, then exit.
worker-once:
	$(WORKER_LOCAL_ENV) WORKER_RUN_ONCE=1 uv run --package ingestion python -m ingestion.local_worker

update-secrets:
	sbx secret set github --sandbox claude-job-hunt-crew -t "$(gh auth token)" -f