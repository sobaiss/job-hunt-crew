# job-hunt-crew

job-hunt-crew is a web application that lets a job-seeking candidate ingest job
postings (via a single URL, a listing URL, or a preconfigured site + filters)
and get a structured, AI-generated comparison against a chosen version of
their CV: what matches, what's missing, and concrete steps to close the gap.

It is free software under the [GNU Affero General Public License v3.0](LICENSE)
(see [License](#license)).

- **To run it**, read [Quick install](#quick-install): Docker and `make` are
  all you need.
- **To work on the code**, read [Develop](#develop).

The full product spec lives in [`PRD.md`](PRD.md). Build history and the
milestone checklist are in [`progress.txt`](progress.txt).

## Quick install

For running the app on your own machine or a personal server. Everything,
the build, the database migrations and the first Administrator included,
runs inside Docker containers.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose v2
  (`docker compose`, included in Docker Desktop).
- `make`.
- Free ports 3000 (the app), 5432, 8000, 9000 and 9324.
- **Windows:** use [WSL 2](https://learn.microsoft.com/windows/wsl/install).
  Install Docker Desktop with its WSL integration turned on, then run every
  command below in a WSL terminal (Ubuntu, say), from a clone inside the WSL
  file system. The setup script is bash: it doesn't run in PowerShell or
  `cmd`.

### Install

```bash
git clone https://github.com/sobaiss/job-hunt-crew.git
cd job-hunt-crew
make setup
```

`make setup` checks the prerequisites and the ports, then asks a few
questions:

1. **The LLM provider** that runs the Analyses: `anthropic`, `openai`,
   `openrouter`, `ollama`, or `later` (Enter), then its API key (for
   `ollama`, its URL). With `later`, the install completes, but Analyses fail
   until a provider is set in **Admin → LLM providers**.
2. **Optional integrations**, each skipped with Enter:
   - the app URL (`APP_URL`, default `http://localhost:3000`);
   - an SMTP server for magic-link sign-in emails (`EMAIL_SERVER`,
     `EMAIL_FROM`);
   - Google and LinkedIn sign-in (client id and secret);
   - the France Travail and Adzuna job sources (free Adzuna keys at
     [developer.adzuna.com](https://developer.adzuna.com/)).
3. **The first Administrator:** email, name and password (masked, asked
   twice, at least 8 characters). The password is never written to disk.

It writes everything to a single `.env` at the repo root, generating
`AUTH_SECRET`, `INTERNAL_API_SECRET` and `SETTINGS_ENCRYPTION_KEY` there. It
then builds and starts the stack, applies the database migrations and the
seed, creates the Administrator and waits until the app answers. The summary
gives:

- the URL to open;
- the Administrator's email;
- the LLM provider;
- the sign-in methods available (the sign-in page shows only those);
- which job sources are active. Remotive, LinkedIn and HelloWork need no
  credentials; France Travail and Adzuna are active only with theirs.

Open the URL and sign in with the Administrator's email and password. The
Admin area is under `/admin`.

Secrets and passwords typed at a prompt are not echoed. Keep `.env` safe: it
holds the secrets, and losing `SETTINGS_ENCRYPTION_KEY` makes the LLM keys
saved from the Admin screen unreadable.

**Without a terminal** (a script, CI), or with `SETUP_NONINTERACTIVE=1`,
`make setup` asks nothing and reads the environment instead:

```bash
SETUP_NONINTERACTIVE=1 \
ADMIN_EMAIL=admin@example.com ADMIN_NAME="Admin" ADMIN_PASSWORD='a long password' \
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... \
  make setup
```

- `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`: the Administrator, for this
  run only (never written to `.env`). Required on a fresh database.
- `LLM_PROVIDER` plus that provider's variable: `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN` (for `huggingface`) or
  `OLLAMA_BASE_URL`. Unset means "later".
- `APP_URL`, `EMAIL_SERVER`, `EMAIL_FROM`, `AUTH_GOOGLE_ID` /
  `AUTH_GOOGLE_SECRET`, `AUTH_LINKEDIN_ID` / `AUTH_LINKEDIN_SECRET`,
  `FRANCE_TRAVAIL_CLIENT_ID` / `FRANCE_TRAVAIL_CLIENT_SECRET`,
  `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`: the optional integrations. Half a pair
  (an id without its secret) fails before anything starts.

`SETUP_HEALTH_TIMEOUT` (seconds, default 300) bounds the final wait.

### Day to day

```bash
make up     # start the app (http://localhost:3000, or your APP_URL)
make down   # stop it; the data stays
```

To change a setting later, edit `.env` and run `make up` again.

### Upgrading

```bash
git pull
make setup
```

Re-running `make setup` is safe. It keeps every `.env` value, regenerates no
secret and doesn't ask again for what is already set. It rebuilds the images,
applies the new migrations and seed data, and restarts the stack. When an
Administrator exists, it offers to create another one and skips that step by
default.

### Starting over

```bash
make reset CONFIRM=1
make setup
```

`make reset CONFIRM=1` stops the stack and deletes its data (the Postgres and
MinIO volumes: users, CVs, Analyses). `.env` is kept. Without `CONFIRM=1` it
only reports what it would delete.

### Adding Administrators

On a terminal, re-run `make setup` and answer `y` to "Create another one?".

Or run `create_admin` in the `api` container, with the stack running
(`make up`). The values come from the environment, so the password stays off
the command line:

```bash
export ADMIN_EMAIL=someone@example.com ADMIN_NAME="Someone"
printf "Password: "; read -rs ADMIN_PASSWORD; echo; export ADMIN_PASSWORD
docker compose run --rm --no-deps -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD api \
  uv run --no-sync --package api python packages/py-db/scripts/create_admin.py
```

A new email creates an Administrator, with the same `free` Subscription as
any new User. An existing User's email promotes that User and resets their
password. An Administrator can also change another User's role from the Admin
area.

### Upgrading from an earlier version

Installations from before `make setup` need to know two things:

- **One `.env` only.** The first `make setup` imports the values of the old
  per-package `apps/web/.env` and `packages/prisma/.env` into the root `.env`.
  Those files are no longer read afterwards; delete them once you've checked
  the root `.env`. Values that were already in the root `.env` win.
- **LLM keys must be re-entered.** The old docker-compose shipped a published
  `SETTINGS_ENCRYPTION_KEY`; `make setup` replaces it with a new one, and says
  so in its summary. The LLM API keys saved from **Admin → LLM providers**
  were encrypted with the old key and can no longer be read. Until you enter
  them again on that screen, the environment's keys are used instead, and the
  logs show `llm_provider_secret_undecryptable`.

## Develop

The contributor path: host tooling, hot reload, the same root `.env`.

### Prerequisites

- Node.js ≥ 22.13, [pnpm](https://pnpm.io/) (pinned via Corepack — `packageManager: pnpm@11.23.0`)
- Python ≥ 3.11, [uv](https://docs.astral.sh/uv/)
- Docker with Compose v2, and `make`

### 1. Install dependencies

```bash
corepack enable
pnpm install
uv sync
```

### 2. Configure `.env`

The whole repo reads **one** env file, `.env` at the repo root (gitignored),
documented by [`.env.example`](.env.example). docker-compose interpolates it
and passes it to `api`, `worker` and `web`; `pnpm dev` and `next build` load
it from `apps/web/next.config.ts`; `make migrate`, `make seed`, `make worker`,
`make web-up` and `make verify-sites` read it too.

Create it with `make setup` (which also starts the whole stack), or with only
the merge step, which asks nothing and starts nothing:

```bash
scripts/setup/env-merge.sh
```

Either one copies `.env.example`'s layout, keeps every value an existing
`.env` already has, imports the legacy `apps/web/.env` and
`packages/prisma/.env`, and generates `AUTH_SECRET`, `INTERNAL_API_SECRET`
and `SETTINGS_ENCRYPTION_KEY` once. docker-compose refuses to start without
those three ("run make setup").

`.env.example` is split into four sections: **required** (`DATABASE_URL`,
for the host-side tools), **generated by setup** (the three secrets, empty in
the example), **optional** (LLM provider and keys, SMTP, OAuth, job-source
credentials) and **advanced** (every tuning knob, commented out with its
default). Container wiring (Postgres/MinIO/ElasticMQ hostnames, queue URLs)
lives in `docker-compose.yml`, not in `.env`.

The LLM settings: `LLM_PROVIDER`
(`anthropic|openai|openrouter|huggingface|ollama`, defaults to `anthropic`,
on the host and in docker-compose alike), `LLM_MODEL`, and the corresponding
API key, read by the crew or a Lambda handler: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` for
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

### 3. Start the stack without the production web

```bash
make up-no-web   # docker compose up -d --scale web=0; stops a running web too
```

**Port 3000 is exclusive.** The stack's `web` service is a production build
of `apps/web` (`apps/web/Dockerfile.production`: `next build`, standalone
server, no source mounted) on `http://localhost:3000`, and so are `pnpm dev`
and `make web-up` (step 5). Run one at a time: start the stack with
`make up-no-web`, or stop its web with `docker compose stop web`. `make up`
starts the stack *with* the production web, as a self-hoster runs it (see
[`docs/adr/0034`](docs/adr/0034-production-web-joins-root-compose-for-self-hosting.md)).

The stack: Postgres, MinIO (S3-compatible, auto-creates the `job-hunt-crew`
bucket), ElasticMQ (SQS-compatible), the `api` container (FastAPI, built from
the repo root so `uv` can resolve the workspace, on `http://localhost:8000`)
and `worker` (step 6). Postgres (5432), MinIO (9000, console 9001) and
ElasticMQ (9324) publish their ports on `127.0.0.1` only: reachable from this
machine, not from your network, since they run with default credentials.

**Step Functions Local** is behind the `stepfunctions` profile and isn't
started by default. Start it when you need the real state machine (step 6):

```bash
docker compose --profile stepfunctions up -d
```

To start over, `make reset CONFIRM=1` stops the stack and deletes the
Postgres and MinIO volumes, keeping `.env` (without `CONFIRM=1` it only
reports what it would delete).

### 4. Migrate and seed the database

Migrations are not applied on `up`. From the host:

```bash
make migrate   # prisma migrate deploy, with DATABASE_URL from the root .env
make seed      # prisma db seed (SiteConfig rows)
```

`make setup` does the same without Node on the host, through the `migrate`
service (`packages/prisma/Dockerfile`, `tools` profile):
`docker compose run --rm migrate` and
`docker compose run --rm migrate pnpm exec prisma db seed`. Create an
Administrator to reach the Admin area: see
[Adding Administrators](#adding-administrators), or from the host,
`uv run --package py-db python packages/py-db/scripts/create_admin.py --help`.

### 5. Run the app

Two interchangeable ways to run `apps/web` in dev mode — pick one, not both
(both bind port 3000, see step 3):

```bash
pnpm dev              # apps/web on http://localhost:3000 (via Turborepo)
```

```bash
make web-up           # same app, in Docker instead — no local Node/pnpm needed
# or: docker compose -f apps/web/docker-compose.yml up
```

`make web-up` builds `apps/web/Dockerfile` and runs `next dev` inside the
container, with `app/`, `components/`, `lib/`, and the rest of the source
bind-mounted for the same hot reload `pnpm dev` gives you. It reads the root
`.env`, only overriding `API_BASE_URL` to reach the host's `api`
container via `host.docker.internal`. It stays outside the root
`docker-compose.yml` on purpose — see
[`docs/adr/0026-web-docker-dev-mode-standalone.md`](docs/adr/0026-web-docker-dev-mode-standalone.md).
A dependency change (not a source edit) needs a rebuild: `docker compose -f
apps/web/docker-compose.yml up --build`. Stop it with `make web-down`.

Either way, `services/api` is already running inside Docker on
`http://localhost:8000` (`/docs` and `/openapi.json` are reachable in dev
without the internal secret).

### 6. The worker

The compose `worker` (the local stand-in for the AWS SQS → Lambda
event-source mappings, see `services/ingestion/src/ingestion/local_worker.py`)
drains all three pipeline queues:

- `cv-conversion` → `analysis.cv_conversion.handle_cv_conversion`.
- `ingestion-intake` → `ingestion.intake_handler.handle_ingestion_intake`
  (the ADR 0002 fan-out worker): runs the discover/scrape/extract pipeline
  for the `IngestionJob`, then creates one `Analysis` per `READY` `JobOffer`
  and enqueues it on `analysis-intake`. This is what makes "Analyse several
  offers" (and "Analyse one offer" on an unknown URL) advance on their own.
  A `SITE_SEARCH` run against France Travail needs
  `FRANCE_TRAVAIL_CLIENT_ID` / `FRANCE_TRAVAIL_CLIENT_SECRET` in `.env`;
  one against Adzuna needs `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` (free keys from
  [developer.adzuna.com](https://developer.adzuna.com/)). Remotive and the
  HTML-scraped sites need no credentials.
- `analysis-intake` → `WORKER_ANALYSIS_MODE=local`: the whole
  AnalysisWorkflow (EnsureCVConverted → EnsureOfferExtracted → the
  comparison crew → persist) in-process via `analysis.local_pipeline`, the
  same shape `cv-conversion` uses — no `stepfunctions-local` / `lambda_shim`
  / registered state machine, just an LLM the crew can reach (`LLM_PROVIDER`
  and its key in `.env`, or Admin → LLM providers). So a `POST /v1/analyses` ("Analyse one offer" on a
  known offer, or a re-run) also completes on its own.

To run `analysis-intake` through the real Step Functions state machine
instead of in-process, run the worker on the host:

```bash
make worker              # long-running; Ctrl-C to stop
# or one-shot: make worker-once   (drains what is queued, then exits)
```

`WORKER_ANALYSIS_MODE=stepfunctions make worker` additionally needs
`stepfunctions-local` (`docker compose --profile stepfunctions up -d`), the
Lambda shim, a Step Functions execution, and
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the environment — see the comments
in `docker-compose.yml` (`stepfunctions-local` / `worker` services) and
`services/analysis/src/analysis/lambda_shim.py`. Restrict the host worker to
a subset with `WORKER_QUEUES=cv-conversion,analysis-intake`.

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
### Configuring the LLM provider from the Admin screen

The environment (step 2) is only the *fallback*. An Administrator can override
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
  same `SETTINGS_ENCRYPTION_KEY`.** `make setup` generates
  it once into `.env`; docker-compose has no default and refuses to start
  without it. Saving a key
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

### Maintenance targets

Dev-database cleanup helpers in the `Makefile`. All of them only report what
they would change unless run with `CONFIRM=1`:

```bash
make clean-analyses CONFIRM=1                  # delete every Analysis
make clean-analyses-failed CONFIRM=1           # delete FAILED Analyses only
make clean-analyses-scout SCOUT_ID=<id>        # delete one Scout's Analyses
make archive-scouts CONFIRM=1                  # set every Scout to ARCHIVED
make reset CONFIRM=1                           # wipe Postgres + MinIO volumes, keep .env
make verify-sites [SITES=LINKEDIN]             # live check of the job sources
```

Deleting an `Analysis` cascades to its `PipelineEvent`, `GeneratedDocument`
and `Application` rows; S3 objects are left behind.

### Testing

```bash
# JS/TS
pnpm lint
pnpm typecheck

# Python — all four suites against a throwaway database (recommended)
make test

# Setup scripts (scripts/setup, bats) — in a container, only Docker needed
make test-setup
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

CI (`.github/workflows/ci.yml`) runs on every push/PR to `main`:
`lint-typecheck` (pnpm lint + typecheck), `web-tests` (Vitest and Playwright),
`setup-tests` (the bats tests), `python-tests` (docker-compose's infra
services, migrations, the `SiteConfig` seed, then the four Python suites),
`web-image` (builds the production web image) and `install-smoke` (`make
setup` non-interactively on a clean runner, then `scripts/setup/smoke-check.sh`:
API health, web 200, the Administrator's sign-in, and a second `make setup`
that must leave `.env` unchanged). Tests never depend on a live LLM call or a
live scrape — fixtures and stubbed providers stand in.

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
│   ├── scout/             Scouts: recurring searches that feed Analyses.
│   └── persistence/       (folded into services/analysis's Lambda handlers)
├── packages/
│   ├── prisma/            schema.prisma (source of truth) + migrations + seed.
│   └── py-db/              SQLAlchemy async models, regenerated via sqlacodegen.
├── PRD.md                 Full product/technical spec.
├── progress.txt           Milestone-by-milestone build log.
├── docker-compose.yml      The stack: Postgres, MinIO (S3), ElasticMQ (SQS),
│                            api, worker (local SQS -> handler stand-in), the
│                            production web; migrate (`tools` profile) and
│                            Step Functions Local (`stepfunctions` profile).
├── scripts/setup/         `make setup` (setup.sh, env-merge.sh) + bats tests.
├── .env.example           Documents the single root .env.
├── LICENSE                AGPL-3.0.
├── pnpm-workspace.yaml / turbo.json    JS/TS workspace (pnpm + Turborepo).
└── pyproject.toml / uv.lock             Python workspace (uv), members:
                                          services/*, packages/py-db.
```

### `apps/web`

Next.js App Router app. Authenticated pages live under `app/(app)/`
(`analyses`, `applications`, `cv-versions`, `ingestion-jobs`, `scouts`,
`quotas`, `settings`, `admin`); `app/(public)/` holds sign-in and
account-blocked. `applications` is a table (column visibility, filters,
multi-select) whose rows open an in-page **quick view** with the full
candidature, offer info, timeline and analysis recall — there is no
standalone `/applications/[id]` page. Plus BFF routes under `app/api/*` that mirror the
`services/api` surface 1:1. `auth.ts` configures NextAuth (email + password,
Email magic-link, Google, LinkedIn OIDC) in JWT mode — no database adapter, no
Prisma at runtime. Only the configured methods are offered, on the sign-in
page and in the provider list (`lib/sign-in-methods.ts`): Google / LinkedIn
when their id and secret are set, the magic link when `EMAIL_SERVER` is set
(or always under `next dev`, which logs the link to the console). `lib/internal-api.ts` is the one place that calls `services/api`.

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
upserts the 8 `SiteConfig` rows (LinkedIn, Indeed, France Travail, Welcome to
the Jungle, Glassdoor, HelloWork, Adzuna, Remotive). `packages/py-db` regenerates SQLAlchemy models from
the live Postgres schema after every migration (`scripts/generate.sh`) — it
is never hand-edited and never a second migration source.

## Data model

See [`PRD.md`](PRD.md) Section 6 for the full schema. In short:

- **User** — NextAuth-synced identity; owns `CVVersion`, `IngestionJob`, `Analysis`.
- **CVVersion** — one labeled, versioned CV upload (PDF/DOCX), parsed into `structuredData`.
- **JobOffer** — one job posting, globally deduplicated by `sourceUrl` (not user-owned).
- **IngestionJob** — one ingestion request (any mode), user-scoped, fans out to N `JobOffer`s.
- **SiteConfig** — data-driven per-site adapter config (selectors or API, seeded for 8 sites).
- **Analysis** — one (JobOffer, CVVersion) comparison, user-scoped; carries the pipeline status and result.
- **PipelineEvent** — observability/debug trail for both ingestion and analysis pipelines.

`IngestionJob` and `Analysis` are the access-control boundary: every query
against them (and CVVersion) must filter by the authenticated `userId`.

## Non-functional notes

- **Security:** encryption at rest/in transit in production; secrets via AWS
  Secrets Manager (never hardcoded); per-user isolation enforced at the query
  layer (Postgres RLS deferred — see `PRD.md` Section 13).
- **Cost control:** `INGESTION_MAX_OFFERS` is env-configurable; per-user
  daily caps are Plan-scoped quotas set from the Admin area
  (docs/adr/0014), not env vars.
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

## License

job-hunt-crew is licensed under the GNU Affero General Public License,
version 3 ([`LICENSE`](LICENSE)). You may use, study, change and share it.
If you run a modified version as a network service, the AGPL requires you
to offer its users the source code of that version.
