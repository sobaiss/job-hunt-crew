.PHONY: up down web-up web-down migrate seed clean-analyses clean-analyses-scout clean-analyses-failed worker worker-once test test-db

# Start local infrastructure (Postgres, MinIO, ElasticMQ, Step Functions
# Local, api, worker). The `migrate` service applies pending Prisma
# migrations before `api` starts — see docker-compose.yml.
up:
	docker compose up -d

down:
	docker compose down

# Run apps/web itself in Docker — the alternative to `pnpm dev` (see
# apps/web/docker-compose.yml and docs/adr/0026). Foreground, not `-d`:
# unlike `up` above, this is meant to feel like `pnpm dev` — logs stream
# here, Ctrl-C stops it. Requires `make up` (or `pnpm dev`'s own
# prerequisite, the infra stack) already running. Mutually exclusive with
# `pnpm dev` — both bind host port 3000.
web-up:
	docker compose -f apps/web/docker-compose.yml up

web-down:
	docker compose -f apps/web/docker-compose.yml down

# Re-run migrations against the running compose Postgres without a full
# `docker compose up` (e.g. after pulling new migrations).
migrate:
	pnpm --filter @job-hunt-crew/prisma exec prisma migrate deploy

seed:
	pnpm --filter @job-hunt-crew/prisma exec prisma db seed

# Talks to the compose Postgres container directly — no host psql required,
# matching how `up`/`down` don't assume anything beyond Docker. Requires
# `make up` first.
PSQL = docker compose exec -T postgres psql -U postgres -d job_hunt_crew

# Delete every Analysis row, across all users. PipelineEvent,
# GeneratedDocument, and Application rows cascade automatically (ON DELETE
# CASCADE in schema.prisma) — this only needs to touch Analysis itself. S3
# objects an Analysis/GeneratedDocument reference (s3ResultKey,
# GeneratedDocument.s3Key) are left orphaned; this cleans up Postgres only,
# not the bucket. Without CONFIRM=1 this only reports how many rows it would
# delete, it does not delete them.
clean-analyses:
	@if [ "$(CONFIRM)" = "1" ]; then \
		$(PSQL) -c 'DELETE FROM "Analysis";'; \
	else \
		count=$$($(PSQL) -tAc 'SELECT count(*) FROM "Analysis";'); \
		echo "This would delete $$count analyses across all users."; \
		echo "Re-run as: make clean-analyses CONFIRM=1"; \
	fi

# Delete every Analysis row produced by one Scout (SCOUT_ID) — "agent" in
# product-facing language, see services/api/CONTEXT.md's Scout entry. Same
# cascade behaviour as clean-analyses, just scoped by scoutId. Errors out on
# a missing/unknown SCOUT_ID rather than silently deleting nothing.
clean-analyses-scout:
	@if [ -z "$(SCOUT_ID)" ]; then \
		echo "SCOUT_ID is required, e.g. make clean-analyses-scout SCOUT_ID=clxxxxx"; \
		exit 1; \
	fi
	@label=$$($(PSQL) -tAc "SELECT label FROM \"Scout\" WHERE id = '$(SCOUT_ID)';"); \
	if [ -z "$$label" ]; then \
		echo "No Scout found with id $(SCOUT_ID)"; \
		exit 1; \
	fi; \
	count=$$($(PSQL) -tAc "SELECT count(*) FROM \"Analysis\" WHERE \"scoutId\" = '$(SCOUT_ID)';"); \
	echo "Deleting $$count analyses for Scout \"$$label\" ($(SCOUT_ID))..."; \
	$(PSQL) -c "DELETE FROM \"Analysis\" WHERE \"scoutId\" = '$(SCOUT_ID)';"

# Delete every FAILED Analysis row, across all users — a narrower sibling of
# clean-analyses for routine cleanup of dead pipeline runs. Same cascade
# behaviour (PipelineEvent, GeneratedDocument, and Application rows cascade
# automatically) and the same S3-orphaning caveat: a FAILED Analysis can
# still carry a populated s3ResultKey (PersistResultLambda can fail to
# read/parse an object the crew run already wrote), and that S3 object is
# left behind — this cleans up Postgres only, not the bucket. Without
# CONFIRM=1 this only reports how many rows it would delete, it does not
# delete them.
clean-analyses-failed:
	@if [ "$(CONFIRM)" = "1" ]; then \
		$(PSQL) -c "DELETE FROM \"Analysis\" WHERE \"status\" = 'FAILED';"; \
	else \
		count=$$($(PSQL) -tAc "SELECT count(*) FROM \"Analysis\" WHERE \"status\" = 'FAILED';"); \
		echo "This would delete $$count failed analyses across all users."; \
		echo "Re-run as: make clean-analyses-failed CONFIRM=1"; \
	fi

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

# --- Tests -----------------------------------------------------------------
#
# The Python suites talk to a real Postgres through `DATABASE_URL`, and the
# repair/backfill tasks they exercise scan the WHOLE JobOffer table. Run
# against the dev database, that is not hypothetical: a suite run once stamped
# `title = "Repaired Title"` onto 10 real LinkedIn offers, via the fake
# `extract_fn` in test_repair_missing_title_offers.py.
#
# Every conftest sets `DATABASE_URL` with `os.environ.setdefault`, and no test
# hardcodes a Postgres URL, so pointing the suites at a throwaway database
# needs no code change at all — just this variable. Creating and migrating it
# takes ~1.5s, which is why it is done fresh on every run rather than kept
# around to drift.
TEST_DB_NAME = jhc_test
TEST_DATABASE_URL = postgresql://postgres:postgres@localhost:5432/$(TEST_DB_NAME)?schema=public

# Drop, recreate, migrate and seed the throwaway database. Seeding matters:
# some API tests assert on the seeded SiteConfig rows.
test-db:
	docker compose exec -T postgres psql -U postgres -c "drop database if exists $(TEST_DB_NAME);"
	docker compose exec -T postgres psql -U postgres -c "create database $(TEST_DB_NAME);"
	DATABASE_URL="$(TEST_DATABASE_URL)" pnpm --filter @job-hunt-crew/prisma exec prisma migrate deploy
	DATABASE_URL="$(TEST_DATABASE_URL)" pnpm --filter @job-hunt-crew/prisma exec prisma db seed

# All four Python suites against that database.
#
# The compose `worker` is stopped for the duration and restarted afterwards:
# it drains the same ElasticMQ queues the tests assert on, so a running worker
# consumes their messages first and fails them with an empty-inbox assertion
# that reads exactly like a real bug. Isolating the queues instead of the
# worker would mean per-test queues in elasticmq.conf — worth doing, not done
# here. S3 stays shared: tests key their objects by uuid and clean up (one
# stray object in 359 measured), so it has not been worth isolating.
test: test-db
	docker compose stop worker
	-DATABASE_URL="$(TEST_DATABASE_URL)" uv run --package ingestion pytest services/ingestion/tests -q
	-DATABASE_URL="$(TEST_DATABASE_URL)" uv run --package scout pytest services/scout/tests -q
	-DATABASE_URL="$(TEST_DATABASE_URL)" uv run --package analysis pytest services/analysis/tests -q
	-DATABASE_URL="$(TEST_DATABASE_URL)" uv run --package api pytest services/api/tests -q
	docker compose start worker

update-secrets:
	sbx secret set github --sandbox claude-job-hunt-crew -t "$(gh auth token)" -f