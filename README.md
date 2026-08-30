# job-hunt-crew

job-hunt-crew is a web application that lets a job-seeking candidate ingest job
postings (via a single URL, a listing URL, or a preconfigured site + filters)
and get a structured, AI-generated comparison against a chosen version of
their CV: what matches, what's missing, and concrete steps to close the gap.

The full product spec lives in [`PRD.md`](PRD.md) — this README is the map for
getting the codebase running and understanding how the pieces fit together.
Build history and the milestone checklist are in [`progress.txt`](progress.txt).

## Status

All milestones (M0–M7) are complete. The app runs a real end-to-end pipeline
locally: auth, CV upload/parsing, all 3 ingestion modes, the async
Step-Functions-orchestrated CrewAI analysis pipeline, and a unified Python
backend behind `apps/web`'s BFF proxy.

## Architecture

```
                      ┌─────────────────────┐
   Browser  ────────▶ │   apps/web (Next.js) │  NextAuth (JWT), UI, thin BFF
                      │   app/api/* routes    │  proxy — no direct DB/S3/SQS
                      └──────────┬───────────┘
                                 │ internal secret + userId
                                 ▼
                      ┌─────────────────────┐
                      │  services/api        │  FastAPI — sole owner of
                      │  (FastAPI)            │  Postgres/S3/SQS
                      └──┬────────┬─────────┬┘
                         │        │         │
                    Postgres     S3        SQS (analysis-intake)
                    (RDS)      (CVs, raw          │
                               scrapes,            ▼
                               results)   ┌─────────────────────────┐
                                          │  Step Functions          │
                                          │  AnalysisWorkflow         │
                                          │  (waitForTaskToken)       │
                                          └──┬──────────┬───────────┘
                                             │          │
                              Lambda: EnsureCVParsed /  Fargate task:
                              EnsureOfferExtracted      CrewAI comparison
                              (services/ingestion,      crew (services/
                               services/analysis           analysis)
                               extraction agents)             │
                                                                ▼
                                                    S3 analysis-results/*.json
                                                                │
                                                     ObjectCreated event
                                                                ▼
                                                    PersistResultLambda
                                                    writes Analysis row
                                                    (services/analysis)
```

**Key design decisions** (see [`PRD.md`](PRD.md) Section 4 & 7 for full rationale):

- **`apps/web` never touches Postgres/S3/SQS directly.** Its `app/api/*`
  routes are a thin BFF: validate the session, forward to `services/api` with
  a shared internal secret + `userId`, pass the response through. The one
  exception is NextAuth itself, which owns the OAuth/magic-link handshake and
  session cookie, and calls `services/api`'s `/internal/*` endpoints instead
  of touching a database directly.
- **`services/api` (FastAPI) is the sole owner of Postgres/S3/SQS.** It's
  internal-only — reachable only from `apps/web`'s server-side code, never
  the browser.
- **The AI pipeline is async and event-driven end to end**, coordinated by
  AWS Step Functions: short steps run as Lambda, the CrewAI crew run itself
  (which can exceed Lambda's 15-minute ceiling) runs as a Fargate task.
  Terminal state is written to Postgres by exactly one Lambda
  (`PersistResultLambda`), triggered by an S3 `ObjectCreated` event — never by
  the workflow directly.
- **The LLM provider is swappable** (Anthropic Claude or OpenAI) via the
  `LLM_PROVIDER` env var, behind a single `LLMProvider` interface
  (`services/analysis/src/analysis/llm_provider.py`) that CrewAI agents never
  bypass.
- **Prisma is schema/migration tooling only.** `packages/prisma/schema.prisma`
  is the single source of truth for the DB schema; Python reads it through
  SQLAlchemy models in `packages/py-db`, regenerated via `sqlacodegen` after
  every migration — never a second independent migration source.

## Monorepo layout

```
job-hunt-crew/
├── apps/
│   └── web/              Next.js (App Router) + NextAuth. UI + thin BFF proxy.
├── services/
│   ├── api/               FastAPI: CRUD, S3 presign, SQS enqueue, auth upsert.
│   │                        Sole owner of Postgres/S3/SQS.
│   ├── ingestion/         Scrapers, Mode 1/2/3 adapters, Lambda handlers.
│   ├── analysis/          CrewAI crew/agents/tasks, Step Functions state
│   │                        machine, Fargate task entrypoint, Lambda handlers
│   │                        (intake, persist-result).
│   └── persistence/       (folded into services/analysis's Lambda handlers)
├── packages/
│   ├── prisma/            schema.prisma (source of truth) + migrations + seed.
│   └── py-db/              SQLAlchemy async models, regenerated via sqlacodegen.
├── PRD.md                 Full product/technical spec.
├── progress.txt           Milestone-by-milestone build log.
├── docker-compose.yml      Local Postgres, MinIO (S3), ElasticMQ (SQS),
│                            Step Functions Local, and the api container.
├── pnpm-workspace.yaml / turbo.json    JS/TS workspace (pnpm + Turborepo).
└── pyproject.toml / uv.lock             Python workspace (uv), members:
                                          services/*, packages/py-db.
```

### `apps/web`

Next.js App Router app. Pages under `app/` (`analyses`, `cv-versions`,
`ingestion-jobs`) plus BFF routes under `app/api/*` that mirror the
`services/api` surface 1:1. `auth.ts` configures NextAuth (Email magic-link,
Google, LinkedIn OIDC) in JWT mode — no database adapter, no Prisma at
runtime. `lib/internal-api.ts` is the one place that calls `services/api`.

### `services/api`

FastAPI app (`src/api/main.py`), internal-only:

- `v1.py` — `/v1/*`: `cv-versions` (list/create/patch), `ingestion-jobs`
  (create/get), `site-configs` (list), `analyses` (list/create/get).
- `internal.py` — `/internal/*`, not in the OpenAPI schema: `users/upsert`
  (called on every NextAuth sign-in) and `auth/verification-tokens[/consume]`
  (backs the Email provider's adapter methods).
- Every request except `/healthz` (and `/docs`, `/redoc`, `/openapi.json` when
  `ENVIRONMENT=development`) must carry a matching `X-Internal-Api-Secret`
  header — see `services/api/tests/test_internal_secret.py`.
- `db.py`, `s3_client.py`, `sqs_client.py` — the only code in the repo that
  opens a Postgres session, presigns an S3 URL, or sends to SQS.

### `services/ingestion`

Mode 1 (single URL), Mode 2 (listing URL, generic "repeated card" heuristic +
fan-out via `fanout.py`), and Mode 3 (preconfigured site + filters via
`site_search.py`/`site_search_pipeline.py`, with France Travail using its
official public API instead of scraping — see `france_travail.py`).
`site_adapters.py` holds the data-driven per-site selector config.

### `services/analysis`

The AI pipeline:

- `llm_provider.py` — provider abstraction, selected via `LLM_PROVIDER`.
- `cv_extraction_agent.py` / `job_offer_extraction_agent.py` — structure raw
  CV/offer content into `structuredData`.
- `comparison_analysis_agent.py` / `recommendation_writer_agent.py` /
  `comparison_crew.py` — the CrewAI crew producing the Section 8.6 result
  schema (match score, matched/missing skills, strengths/weaknesses,
  prioritized suggestions, summary).
- `crew_task.py` — Fargate task entrypoint.
- `state_machine/analysis_workflow.asl.json` — the Step Functions state
  machine definition (Amazon States Language).
- `intake_handler.py`, `handlers.py`, `persist_result_lambda.py` — the Lambda
  handlers around the crew run (SQS intake, `EnsureCVParsed`/
  `EnsureOfferExtracted`, S3-event-triggered result persistence).
- `lambda_shim.py` — local stand-in for the 3 real Lambda functions, so
  Step Functions Local has something to invoke in dev (see docker-compose
  comments).

### `packages/prisma` and `packages/py-db`

`packages/prisma/schema.prisma` is the single schema source of truth;
`prisma/migrations/` holds the applied migration history and `prisma/seed.js`
seeds the 5 `SiteConfig` rows (LinkedIn, Indeed, France Travail, Welcome to
the Jungle, Glassdoor). `packages/py-db` regenerates SQLAlchemy models from
the live Postgres schema after every migration (`scripts/generate.sh`) — it
is never hand-edited and never a second migration source.

## Data model

See [`PRD.md`](PRD.md) Section 6 for the full schema. In short:

- **User** — NextAuth-synced identity; owns `CVVersion`, `IngestionJob`, `Analysis`.
- **CVVersion** — one labeled, versioned CV upload (PDF/DOCX), parsed into `structuredData`.
- **JobOffer** — one job posting, globally deduplicated by `sourceUrl` (not user-owned).
- **IngestionJob** — one ingestion request (any mode), user-scoped, fans out to N `JobOffer`s.
- **SiteConfig** — data-driven per-site adapter config (selectors or API, seeded for 5 sites).
- **Analysis** — one (JobOffer, CVVersion) comparison, user-scoped; carries the pipeline status and result.
- **PipelineEvent** — observability/debug trail for both ingestion and analysis pipelines.

`IngestionJob` and `Analysis` are the access-control boundary: every query
against them (and CVVersion) must filter by the authenticated `userId`.

## Setup

### Prerequisites

- Node.js ≥ 22.13, [pnpm](https://pnpm.io/) (pinned via Corepack — `packageManager: pnpm@11.23.0`)
- Python ≥ 3.11, [uv](https://docs.astral.sh/uv/)
- Docker (for Postgres, MinIO, ElasticMQ, Step Functions Local)

### 1. Install dependencies

```bash
corepack enable
pnpm install
uv sync
```

### 2. Start local infrastructure

```bash
docker compose up -d
```

This starts Postgres, MinIO (S3-compatible, auto-creates the `job-hunt-crew`
bucket), ElasticMQ (SQS-compatible), Step Functions Local, and the `api`
container (FastAPI, built from the repo root so `uv` can resolve the
workspace).

### 3. Configure environment variables

Copy the example env files and fill in secrets:

```bash
cp apps/web/.env.example apps/web/.env
cp packages/prisma/.env.example packages/prisma/.env
```

`apps/web/.env` covers NextAuth (`AUTH_SECRET`, OAuth provider credentials),
`API_BASE_URL`/`INTERNAL_API_SECRET` (must match the `api` container's env in
`docker-compose.yml`), S3/SQS endpoints (pointed at MinIO/ElasticMQ by
default), and the cost-control guardrails (`INGESTION_MAX_OFFERS`,
`DAILY_ANALYSIS_CAP`). `services/analysis` additionally reads `LLM_PROVIDER`
(`anthropic|openai`, defaults to `anthropic`), `LLM_MODEL`, and the
corresponding `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from the environment when
running the crew or a Lambda handler locally.

### 4. Apply the database schema

```bash
pnpm --filter @job-hunt-crew/prisma exec prisma migrate deploy
pnpm --filter @job-hunt-crew/prisma exec prisma db seed
```

### 5. Run the app

```bash
pnpm dev              # apps/web on http://localhost:3000 (via Turborepo)
```

`services/api` is already running inside Docker on `http://localhost:8000`
(`/docs` and `/openapi.json` are reachable in dev without the internal
secret). To exercise the async analysis pipeline locally you also need the
Lambda shim and a Step Functions execution — see the comments in
`docker-compose.yml` (`stepfunctions-local` service) and
`services/analysis/src/analysis/lambda_shim.py`.

## Testing

```bash
# JS/TS
pnpm lint
pnpm typecheck

# Python (run against the docker-compose Postgres/MinIO/ElasticMQ)
uv run --package api pytest services/api/tests -q
uv run --package ingestion pytest services/ingestion/tests -q
uv run --package analysis pytest services/analysis/tests -q
```

This is exactly what CI (`.github/workflows/ci.yml`) runs on every push/PR to
`main`: a `lint-typecheck` job (pnpm lint + typecheck) and a `python-tests`
job (spins up docker-compose's infra services, applies migrations, seeds
`SiteConfig`, then runs all three Python test suites). Tests never depend on
a live LLM call or a live scrape — fixtures and stubbed providers stand in.

## Non-functional notes

- **Security:** encryption at rest/in transit in production; secrets via AWS
  Secrets Manager (never hardcoded); per-user isolation enforced at the query
  layer (Postgres RLS deferred — see `PRD.md` Section 13).
- **Cost control:** `INGESTION_MAX_OFFERS` and `DAILY_ANALYSIS_CAP` are both
  env-configurable, not code changes.
- **Resilience:** no pipeline step silently swallows failure — every terminal
  `FAILED`/`PARTIALLY_COMPLETED` state carries an `errorMessage`, with up to
  3 retries (exponential backoff) before giving up.
- **Known tradeoffs:** the `apps/web` ↔ `services/api` boundary trusts a
  shared secret + `userId` header rather than independently verifying a
  signed session token; see `PRD.md` Section 14 ("Open Risks") for this and
  other accepted MVP tradeoffs.

## Further reading

- [`PRD.md`](PRD.md) — full product/technical spec, including the functional
  requirements (Section 8), API surface (Section 9), the async pipeline
  sequence (Section 10), assumptions (Section 13), and open risks (Section 14).
- [`progress.txt`](progress.txt) — milestone-by-milestone build log with
  verification output for every completed task.
