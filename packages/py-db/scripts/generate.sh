#!/usr/bin/env bash
# Regenerates src/py_db/models.py from the live Postgres schema via sqlacodegen.
# Run this after every Prisma migration (packages/prisma is the schema source of truth).
set -euo pipefail
cd "$(dirname "$0")/.."

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/job_hunt_crew}"
SYNC_URL="${DATABASE_URL/postgresql:\/\//postgresql+psycopg2://}"

uv run --package py-db sqlacodegen "$SYNC_URL" --outfile src/py_db/models.py
