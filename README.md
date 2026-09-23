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
- **The LLM provider is swappable** (`anthropic` | `openai` | `openrouter` |
  `huggingface` | `ollama`) via the `LLM_PROVIDER` env var (or an
  Administrator's override in Postgres, see "Configuring the LLM provider from
  the Admin screen" below), behind a single
  `LLMProvider` interface (`services/analysis/src/analysis/llm_provider.py`)
  that CrewAI agents never bypass. `anthropic`/`openai` are the
  production-supported options. `openrouter`/`huggingface` are also hosted,
  paid backends (API key required), routed through their OpenAI-compatible
  endpoints — opt-in for trying alternate models, **not yet vetted for
  production traffic**. `ollama` routes every call to a local Ollama server
  (no key, no per-token cost) and is a **dev-local convenience only — not a
  supported production backend**; production stays on `anthropic`/`openai`.
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
│                            Step Functions Local, the api container, migrate
│                            (Prisma migrations on startup), and worker (local
│                            SQS -> handler stand-in, drains cv-conversion).
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
- `local_pipeline.py` — dev-only: chains those same handlers in-process
  (no Step Functions) so the compose `worker` can drain `analysis-intake`
  the way it already drains `cv-conversion`.

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
# or: make up
```

This starts Postgres, MinIO (S3-compatible, auto-creates the `job-hunt-crew`
bucket), ElasticMQ (SQS-compatible), Step Functions Local, `migrate` (applies
pending Prisma migrations against Postgres, then exits — see
`packages/prisma/Dockerfile`), the `api` container (FastAPI, built from the
repo root so `uv` can resolve the workspace), and `worker` (the local
stand-in for the AWS SQS → Lambda event-source mappings; drains all three
pipeline queues — `cv-conversion`, `ingestion-intake`, `analysis-intake` —
so "Convert to Markdown", "Analyse one offer" and "Analyse several offers"
all work out of the box — see
`services/ingestion/src/ingestion/local_worker.py`). `api` waits for
`migrate` to finish successfully before starting, so a fresh Postgres volume
never leaves `api` running against a missing schema.

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
(`anthropic|openai|openrouter|huggingface|ollama`, defaults to `anthropic`),
`LLM_MODEL`, and the corresponding API key from the environment when running
the crew or a Lambda handler locally: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` for
the production-supported providers, or `OPENROUTER_API_KEY`/`HF_TOKEN` for
`openrouter`/`huggingface` — also hosted, paid backends (routed through their
OpenAI-compatible endpoints), opt-in for trying alternate models and **not
yet vetted for production traffic**. `LLM_PROVIDER=ollama` is **dev-local
only, not a supported production backend**: it needs no API key, talks to a
local Ollama server at `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`;
`http://host.docker.internal:11434/v1` from the containerised worker), and
defaults `LLM_MODEL` to `qwen2.5:7b`. The pipeline sets no `num_ctx` and
relies on Ollama's server default context window; on an old or
RAM-constrained install, raise it server-side via `OLLAMA_CONTEXT_LENGTH`.

#### Configuring the LLM provider from the Admin screen

The environment above is only the *fallback*. An Administrator can override
it from **Admin → LLM providers** (docs/adr/0024) without a redeploy:

- Choose the **Active LLM provider** in the table, and open a provider's row to
  set its parameters (API key, base URL, model). The change applies to the next
  pipeline step. Selecting the **None — follow the environment** row hands
  control back to the environment, which is exactly how an installation that
  never touches the screen behaves.
- Values resolve **parameter by parameter**: a stored value wins, else that
  parameter's environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, `HF_TOKEN`, `OLLAMA_BASE_URL`), else the provider's own
  default. `LLM_MODEL` only governs the environment-driven mode: an empty stored
  model falls back to the provider's default, never to `LLM_MODEL`. A provider
  never falls back to a *different* provider; a required parameter that resolves
  nowhere fails the pipeline step naming the provider and parameter.
- **API keys are encrypted at rest** (Fernet) with `SETTINGS_ENCRYPTION_KEY`.
  The screen only ever shows a key's last four characters, never the key, and
  the audit trail records "(set)" / "(cleared)" rather than a value. Generate
  one with:

  ```bash
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  ```

  **The API, the worker and every Analysis and Ingestion process must share the
  same `SETTINGS_ENCRYPTION_KEY`.** docker-compose ships a dev-only default for
  the `api` and `worker` services; set your own anywhere real. Saving a key
  without a usable `SETTINGS_ENCRYPTION_KEY` fails with an error and stores
  nothing. A stored key that can no longer be decrypted (lost or rotated
  `SETTINGS_ENCRYPTION_KEY`) is treated as not set: the environment's key is
  used instead, and an ERROR log line
  (`llm_provider_secret_undecryptable`) names the provider and parameter.
  Stored keys are not re-encrypted under a new `SETTINGS_ENCRYPTION_KEY`; enter
  them again.
- **The API must receive the same LLM-related environment as the workers**
  (`LLM_PROVIDER`, `LLM_MODEL`, the four API keys, `OLLAMA_BASE_URL`). The
  screen evaluates the environment itself — to name the provider the
  environment resolves to, show which parameters are "Inherited", and refuse
  activating a provider whose key lives nowhere. docker-compose passes them to
  both services; if you deploy elsewhere, keep the two in step or the screen
  will misreport what actually runs.

### 4. Seed the database

Step 2's `migrate` service already applied the schema. Seed data still needs
a manual run:

```bash
pnpm --filter @job-hunt-crew/prisma exec prisma db seed
# or: make seed
```

If you ever need to (re-)apply migrations without a full `docker compose up`
(e.g. after pulling new ones):

```bash
pnpm --filter @job-hunt-crew/prisma exec prisma migrate deploy
# or: make migrate
```

### 5. Run the app

Two interchangeable ways to run `apps/web` — pick one, not both (both bind
`http://localhost:3000`):

```bash
pnpm dev              # apps/web on http://localhost:3000 (via Turborepo)
```

```bash
make web-up           # same app, in Docker instead — no local Node/pnpm needed
# or: docker compose -f apps/web/docker-compose.yml up
```

`make web-up` builds `apps/web/Dockerfile` and runs `next dev` inside the
container, with `app/`, `components/`, `lib/`, and the rest of the source
bind-mounted for the same hot reload `pnpm dev` gives you. It reuses
`apps/web/.env`, only overriding `API_BASE_URL` to reach the host's `api`
container via `host.docker.internal`. It stays outside the root
`docker-compose.yml` on purpose — see
[`docs/adr/0026-web-docker-dev-mode-standalone.md`](docs/adr/0026-web-docker-dev-mode-standalone.md).
A dependency change (not a source edit) needs a rebuild: `docker compose -f
apps/web/docker-compose.yml up --build`. Stop it with `make web-down`.

Either way, `services/api` is already running inside Docker on
`http://localhost:8000` (`/docs` and `/openapi.json` are reachable in dev
without the internal secret).

The compose `worker` drains all three pipeline queues:

- `cv-conversion` → `analysis.cv_conversion.handle_cv_conversion`.
- `ingestion-intake` → `ingestion.intake_handler.handle_ingestion_intake`
  (the ADR 0002 fan-out worker): runs the discover/scrape/extract pipeline
  for the `IngestionJob`, then creates one `Analysis` per `READY` `JobOffer`
  and enqueues it on `analysis-intake`. This is what makes "Analyse several
  offers" (and "Analyse one offer" on an unknown URL) advance on their own.
  A `SITE_SEARCH` run against France Travail needs
  `FRANCE_TRAVAIL_CLIENT_ID` / `FRANCE_TRAVAIL_CLIENT_SECRET` in the host
  env (passed through to the container); one against Adzuna needs
  `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` (free keys from
  [developer.adzuna.com](https://developer.adzuna.com/)). Remotive and the
  HTML-scraped sites need no credentials.

### Job sources and anti-bot blocking

Every fetch goes through `ingestion.fetch.fetch_page`, which climbs a
three-rung ladder per URL: the hardened shared HTTP client (browser headers,
per-host pacing, bounded retry with backoff) → a headless browser, when the
site is client-rendered (`SiteConfig.requiresJsRendering`) or when the block
it hit is one a browser can clear → stop, with a `BLOCKED_<KIND>:` reason.
`ingestion.blocking` classifies interstitials and decides that middle step: a
JS challenge is worth a browser, a CAPTCHA wall never is.

Where the seeded sites stand, all verified live:

| Source | Status |
| --- | --- |
| France Travail, Adzuna, Remotive | `OFFICIAL_API` — structured JSON, no scrape, **no extraction LLM call**, nothing to block |
| LinkedIn | Works over plain HTTP; offer pages carry `JobPosting` JSON-LD. Watch for HTTP 999 on a datacenter IP |
| HelloWork | Works over plain HTTP |
| WTTJ | Browser tier reaches the site, but its search URL/selectors are stale — a site-adapter fix, not a blocking one |
| Indeed, Glassdoor | **Disabled.** Cloudflare CAPTCHA wall that neither rung can clear; use Adzuna for comparable French coverage |

The browser rung needs the optional extra (the `worker` image installs both):

```bash
uv sync --package ingestion --extra browser
uv run --package ingestion python -m playwright install chromium
```

Tuning: `SCRAPER_MIN_DELAY_SECONDS` (default 1.0, minimum seconds between two
requests to the same host), `SCRAPER_MAX_RETRIES` (default 3),
`SCRAPER_USER_AGENT`, and `BROWSER_FETCH_ENABLED=0` to switch the browser rung
off. The test suite sets the last two so no test launches a browser or paces.
- `analysis-intake` → `WORKER_ANALYSIS_MODE=local`: the whole
  AnalysisWorkflow (EnsureCVConverted → EnsureOfferExtracted → the
  comparison crew → persist) in-process via `analysis.local_pipeline`, the
  same shape `cv-conversion` uses — no `stepfunctions-local` / `lambda_shim`
  / registered state machine, just an LLM the crew can reach (`LLM_PROVIDER`,
  `ollama` by default). So a `POST /v1/analyses` ("Analyse one offer" on a
  known offer, or a re-run) also completes on its own.

To run `analysis-intake` through the real Step Functions state machine
instead of in-process, run the worker on the host:

```bash
make worker              # long-running; Ctrl-C to stop
# or one-shot: make worker-once   (drains what is queued, then exits)
```

`WORKER_ANALYSIS_MODE=stepfunctions make worker` additionally needs the
Lambda shim, a Step Functions execution, and
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the environment — see the comments
in `docker-compose.yml` (`stepfunctions-local` / `worker` services) and
`services/analysis/src/analysis/lambda_shim.py`. Restrict the host worker to
a subset with `WORKER_QUEUES=cv-conversion,analysis-intake`.

## Testing

```bash
# JS/TS
pnpm lint
pnpm typecheck

# Python — all four suites against a throwaway database (recommended)
make test
```

`make test` drops, recreates, migrates and seeds a `jhc_test` database
(~1.5s), runs the four suites against it, and pauses the compose `worker`
for the duration.

**Run it this way rather than calling pytest directly against the dev
database.** The suites exercise repair/backfill tasks that scan the *whole*
`JobOffer` table, and their fake `extract_fn` writes to every row it is
handed. Against the dev database that is destructive — one run overwrote the
titles of 10 real LinkedIn offers with the literal string `"Repaired Title"`.
The tests now refuse to mutate rows they did not create
(`_guarded_extract_fn`), but a throwaway database is the boundary that does
not depend on every future test remembering to.

The worker is paused because it drains the same ElasticMQ queues the tests
assert on; left running, it consumes their messages first and the tests fail
with an empty-inbox assertion that looks exactly like a real bug. S3 stays
shared — tests key objects by uuid and clean up after themselves.

**Known residual flakiness.** Each suite is green on its own (164 / 38 / 222 /
450). Run back to back by `make test`, a single test occasionally fails, and a
different one each time — seen so far in `test_workflow_e2e`,
`test_v1_application_stats` and `test_v1_analyses`. They pass on a re-run.
This is cross-suite contention over the resources that are still shared
(ElasticMQ, MinIO, Step Functions Local), and it predates the throwaway
database — that isolates Postgres only. Re-run the affected suite before
treating such a failure as real.

Individual suites, if you need one in isolation (same isolation, set the
variable yourself):

```bash
make test-db
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/jhc_test?schema=public" \
  uv run --package ingestion pytest services/ingestion/tests -q
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
