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

# Run the local SQS worker on the host against the running compose infra —
# the stand-in for the AWS SQS -> Lambda event-source mappings. Drains ALL
# three pipeline queues by default (override with WORKER_QUEUES=...). The
# compose `worker` service already covers `cv-conversion`; use this to also
# drive `analysis-intake` / `ingestion-intake` (needs the Lambda shim, a
# Step Functions execution, and LLM keys — see README section 5).
worker:
	uv run --package ingestion python -m ingestion.local_worker

# Drain whatever is currently queued, then exit.
worker-once:
	WORKER_RUN_ONCE=1 uv run --package ingestion python -m ingestion.local_worker
