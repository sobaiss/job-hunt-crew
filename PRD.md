# PRD — job-hunt-crew

## 0. How Autonomous Agents Should Use This Document

This PRD is the fixed specification for an autonomous coding-agent loop. Each iteration:

1. Read `progress.txt` in full before reading anything else.
2. Find the earliest Milestone in Section 12 that is not marked complete.
3. Within that milestone, find the first task whose checkbox is unchecked.
4. Implement ONLY that task (plus any trivial prerequisite plumbing it strictly requires).
5. Run the exact verification command(s) listed for that task.
6. If verification passes: check the box in `progress.txt`, append a dated log line
   (`YYYY-MM-DD HH:MM — <task-id> — DONE — <verification output summary>`), and stop.
7. If verification fails: append a dated log line describing the failure, leave the
   box unchecked, and stop (do not cascade into unrelated tasks).
8. Never invent requirements not present in this PRD. If a requirement is genuinely
   ambiguous, resolve it using the defaults in Section 13 (Assumptions) — do not
   block on asking a human.
9. Do not skip ahead to a later milestone's tasks even if they seem easy, unless
   explicitly marked "parallelizable" in Section 12.

## 1. Overview & Problem Statement

job-hunt-crew is a web application that lets a job-seeking candidate ingest job
postings (via one of three methods) and receive a structured, AI-generated
comparison against a chosen version of their CV: what matches, what's missing,
and concrete steps to close the gap.

## 2. Goals & Non-Goals

**Goals (MVP):**
- Candidate can authenticate and manage multiple named CV versions.
- Candidate can ingest job offers via all 3 modes (single URL, listing URL,
  preconfigured-site + filters).
- Candidate can request a structured gap analysis of any (JobOffer, CVVersion) pair.
- Pipeline is asynchronous and event-driven end to end.
- Data is strictly isolated per authenticated user.
- LLM provider is swappable (Claude or OpenAI) via configuration, not hardcoded.

**Non-Goals (MVP):** auto-rewriting the candidate's CV file; recruiter/employer-facing
features; payments/billing; native mobile apps; guaranteed successful scraping of
every listed site (best-effort, see Section 14 Risks); actual Terraform/CDK IaC code.

## 3. Personas & User Stories

**Persona:** Job-seeking candidate, applies to multiple roles, tailors CV per role
or industry, wants fast objective feedback on fit before applying.

- As a candidate, I can sign up/sign in with Email, Google, or LinkedIn.
- As a candidate, I can upload and label multiple CV versions (e.g. "Software
  Engineer — Fintech"), and mark one as default.
- As a candidate, I can paste a single job offer URL and get it parsed.
- As a candidate, I can paste a listing/search-results URL and have multiple
  offers discovered and parsed.
- As a candidate, I can pick a supported site and enter filters (location, recency,
  contract type, remote policy) instead of hunting for a URL myself.
- As a candidate, I can request an analysis of any offer against any of my CV
  versions and see match score, matched/missing skills, strengths, weaknesses,
  and prioritized improvement suggestions.
- As a candidate, I can compare the same offer against two or more CV versions
  side by side.

## 4. Tech Stack Decisions

| Layer | Decision | Rationale |
|---|---|---|
| Frontend | Next.js (App Router), TypeScript | User-specified |
| Frontend hosting | AWS — OpenNext on Lambda+CloudFront, or Fargate | User-specified mono-cloud preference |
| Auth | NextAuth.js (Auth.js): Email, Google, LinkedIn providers | User-specified |
| Schema source of truth | Prisma (schema + migrations), used directly by Next.js | User-specified |
| Python DB access | SQLAlchemy (async, asyncpg); models regenerated from the live Postgres schema (via `sqlacodegen`) after every Prisma migration — never a second independent migration source | Avoids dual-schema drift, explicit user requirement |
| Backend language | Python 3.11+ | User-specified |
| AI orchestration | CrewAI multi-agent crew (extraction, comparison, recommendation agents) | User-specified; repo name confirms intent |
| LLM provider | Abstracted provider interface supporting both Anthropic Claude and OpenAI, selected via env var (`LLM_PROVIDER=anthropic\|openai`), model id also via env var | User-specified: configurable/both |
| Compute orchestration | AWS Step Functions (`waitForTaskToken` pattern for the crew step) coordinating Lambda; Fargate task for the crew run itself (exceeds Lambda's 15-min ceiling) | Matches user's async trigger → S3 → persist description |
| Object storage | AWS S3 | User-specified: CVs, raw scrapes, analysis results |
| Relational DB | AWS RDS PostgreSQL, single instance for MVP | User-specified Postgres; RDS over Aurora — open config point, default chosen for MVP simplicity |
| Event glue | SQS (job intake) + S3 `ObjectCreated` → Lambda (result persistence) | Matches user's described trigger → S3 → persist flow |
| Monorepo tooling | pnpm workspaces + Turborepo (JS/TS); `uv` workspace (Python) | Standard, agent-friendly |
| CI/CD | GitHub Actions | Reasonable default, not specified |
| IaC | Explicitly out of scope — this PRD describes target architecture only | User-specified |

## 5. Monorepo Layout

```
job-hunt-crew/
├── apps/
│   └── web/                       # Next.js (App Router), NextAuth, Prisma client usage
├── services/
│   ├── ingestion/                 # Python: scrapers, Mode 1/2/3 adapters, Lambda handlers
│   ├── analysis/                  # Python: CrewAI crew/agents/tasks, Fargate task entrypoint
│   └── persistence/                # Python: S3-event Lambda handlers -> Postgres via SQLAlchemy
├── packages/
│   ├── prisma/                    # schema.prisma (source of truth) + migrations
│   ├── shared-types/              # TS types + JSON Schema for Analysis output
│   └── py-db/                     # SQLAlchemy models regenerated via sqlacodegen
├── docs/
│   ├── PRD.md
│   └── adr/                       # architecture decision records
├── progress.txt
├── pnpm-workspace.yaml / turbo.json
└── pyproject.toml                 # uv workspace root
```

## 6. Data Model

```
User
  id, email (unique), emailVerified, name, image, createdAt, updatedAt
  -> cvVersions[], ingestionJobs[], analyses[]
  (+ standard NextAuth Prisma-adapter tables: Account, Session, VerificationToken)

CVVersion
  id, userId (fk), label, fileKey (S3: cvs/{userId}/{cvVersionId}/{filename}),
  fileName, fileType (PDF|DOCX), fileSizeBytes, isDefault,
  parseStatus (PENDING|PARSING|PARSED|FAILED),
  structuredData (json?: skills, experience, education),
  structuredDataVer, createdAt, updatedAt

JobOffer                            # globally deduplicated by canonical URL
  id, sourceUrl (unique), sourceSite (LINKEDIN|INDEED|FRANCE_TRAVAIL|WTTJ|GLASSDOOR|OTHER),
  title, company, location, postedAt,
  rawContentKey (S3: raw-scrapes/{jobOfferId}.html),
  structuredData (json?: description, requirements, salary, contractType, remotePolicy, seniority),
  extractionStatus (PENDING|SCRAPING|SCRAPED|EXTRACTING|READY|FAILED),
  errorMessage, createdAt, updatedAt

IngestionJob                        # one per user-initiated ingestion request (any mode)
  id, userId (fk), mode (SINGLE_URL|LISTING_URL|SITE_SEARCH),
  inputUrl (modes 1&2), siteConfigId (fk?, mode 3),
  filters (json?: keywords, location, postedWithin, contractType, remote, experienceLevel),
  maxOffers (default 25), status (PENDING|RUNNING|PARTIALLY_COMPLETED|COMPLETED|FAILED),
  discoveredCount, scrapedCount, failedCount, errorMessage, createdAt, updatedAt
  -> jobOffers[] via IngestionJobOffer join table

IngestionJobOffer (join table)
  id, ingestionJobId, jobOfferId, createdAt

SiteConfig                          # data-driven per-site adapter config, seeded for the 5 sites
  id, siteKey (LINKEDIN|INDEED|FRANCE_TRAVAIL|WTTJ|GLASSDOOR), displayName, baseUrl,
  searchUrlTemplate, filterParamMapping (json: our filter enum -> site query param/value),
  listItemSelector/offerLinkSelector/offerTitleSelector (json?, CSS selectors, null if API),
  integrationType (HTML_SCRAPE|OFFICIAL_API), apiBaseUrl (?),
  requiresJsRendering (bool), antiBotRiskLevel (LOW|MEDIUM|HIGH), enabled (bool),
  notes, createdAt, updatedAt

Analysis
  id, userId (fk), jobOfferId (fk), cvVersionId (fk),
  status (PENDING|QUEUED|RUNNING_CREW|AWAITING_RESULT|PERSISTING|COMPLETED|FAILED),
  s3ResultKey (analysis-results/{analysisId}.json), matchScore (0-100),
  resultJSON (json, see Section 8.6), errorMessage, stepFunctionExecutionArn,
  requestedAt, startedAt, completedAt

PipelineEvent (observability/debug trail)
  id, analysisId?, ingestionJobId?, stage, status, message, createdAt
```

**Design decision:** `JobOffer` is globally deduplicated by `sourceUrl` (not
user-owned) to avoid re-scraping/re-extracting the same posting for every user.
`IngestionJob` and `Analysis` are strictly user-scoped and are the access-control
boundary — every query must filter by the authenticated `userId`.

## 7. System Architecture (narrative)

Next.js frontend is the sole entry point for the candidate. It talks to its own
API routes (BFF), which read/write via Prisma for synchronous data (CVs,
offers, ingestion job status, analysis status) and enqueue async work via SQS.
Python services run as Lambda (short steps) and Fargate (the CrewAI crew run,
which can exceed Lambda's timeout), orchestrated by AWS Step Functions using the
`waitForTaskToken` pattern so the state machine waits for the crew without
holding a Lambda open. Crew output is validated and written to S3; an S3
`ObjectCreated` event triggers the sole writer of terminal state
(`PersistResultLambda`), which persists to Postgres via SQLAlchemy. The frontend
polls analysis status until terminal.

## 8. Functional Requirements

### 8.1 Authentication & Multi-Tenancy
- NextAuth.js with Email (magic link), Google OAuth, LinkedIn OIDC providers.
- Every `CVVersion`, `IngestionJob`, `Analysis` row is scoped to `userId`; all
  reads/writes must filter by the authenticated session's user — no
  cross-user access, enforced at the API/query layer (Postgres RLS deferred,
  see Section 13).

### 8.2 CV Management (Upload, Parsing, Versioning)
- Candidate uploads a CV file (PDF or DOCX, max 10MB) with a label.
- File is stored via S3 presigned upload at `cvs/{userId}/{cvVersionId}/{filename}`.
- Exactly one `CVVersion` per user may be `isDefault=true` at a time.
- On upload, a `CVExtractionAgent` (CrewAI) parses the file into `structuredData`
  (skills, experience, education); `parseStatus` tracks progress; re-parsed only
  if the file changes.
- Non-PDF/DOCX uploads are rejected with a clear error before any S3 write.

### 8.3 Job Offer Ingestion — Mode 1: Single Offer URL
1. User submits one URL believed to point at a single job posting.
2. Backend matches the URL's domain against enabled `SiteConfig` rows; if
   matched, uses that site's selectors; otherwise falls back to a generic
   extractor (content extraction + LLM-based field extraction).
3. Creates `JobOffer` (status `PENDING`) and `IngestionJob` (mode `SINGLE_URL`,
   `maxOffers=1`).
4. Scrape step fetches HTML, stores it at `raw-scrapes/{jobOfferId}.html`, sets
   status `SCRAPED`.
5. `JobOfferExtractionAgent` (CrewAI) structures the content; success →
   `READY`; unreachable/empty/blocked content → `FAILED` with `errorMessage`
   after up to 3 retries (no unbounded retry loop).

### 8.4 Job Offer Ingestion — Mode 2: Listing/Search-Results URL
1. User submits a URL of a listing/search page.
2. Backend fetches the page (pagination capped, default 3 pages) and extracts
   candidate offer URLs — via `SiteConfig` selectors if domain matches, else a
   generic "repeated card" heuristic (documented as lower accuracy).
3. Deduplicates URLs, caps total at `IngestionJob.maxOffers` (default 25).
4. For each retained URL, creates/links a `JobOffer` (or reuses an existing
   globally-deduplicated one) and runs the Mode 1 pipeline.
5. `IngestionJob` aggregates `discoveredCount/scrapedCount/failedCount`;
   overall status `COMPLETED` only when every child offer reaches a terminal
   state, `PARTIALLY_COMPLETED` if some fail.

### 8.5 Job Offer Ingestion — Mode 3: Preconfigured Site + Filters
1. User selects a site from a dropdown sourced from `SiteConfig` where
   `enabled=true` (LinkedIn, Indeed, France Travail, Welcome to the Jungle,
   Glassdoor).
2. User supplies filters: `keywords` (free text), `location` (free text),
   `postedWithin` (`24h|7d|14d|30d|any`), `contractType` (optional), `remote`
   (`onsite|hybrid|remote`, optional), `experienceLevel` (optional).
3. Backend builds the target URL/API call from `SiteConfig.searchUrlTemplate` +
   `filterParamMapping`. **France Travail uses its official public API
   (francetravail.io), `integrationType=OFFICIAL_API`, not HTML scraping.**
4. The constructed URL/query feeds into the Mode 2 listing pipeline.
5. Per-site failure (e.g. LinkedIn blocking the request) marks the
   `IngestionJob` `FAILED`/`PARTIALLY_COMPLETED` with a clear `errorMessage` —
   never a silent zero-result return.

### 8.6 AI Analysis Pipeline — Output Schema
CrewAI's final agent must emit (validated as a Pydantic model before the S3
write, and again before Postgres persistence — malformed payload →
`Analysis.status=FAILED`, never a silent partial write):

```json
{
  "match_score": 0,
  "matched_skills": [{"skill": "string", "evidence": "string"}],
  "missing_skills": [{"skill": "string", "importance": "required|nice_to_have"}],
  "strengths": ["string"],
  "weaknesses": ["string"],
  "improvement_suggestions": [
    {"area": "string", "suggestion": "string", "priority": "high|medium|low"}
  ],
  "summary": "string",
  "generated_at": "ISO-8601 timestamp",
  "model_used": "string",
  "job_offer_id": "uuid",
  "cv_version_id": "uuid"
}
```

### 8.7 Results Dashboard & UI
- List of past analyses with status, score, offer title/company.
- Detail view rendering all 5 categories (matched/missing skills,
  strengths/weaknesses, suggestions) + score.
- Side-by-side comparison of one `JobOffer` against 2+ `CVVersion`s.

## 9. API Surface (Next.js API routes, BFF)

- `POST /api/cv-versions` — create + presigned upload URL
- `GET /api/cv-versions` — list current user's CVs
- `PATCH /api/cv-versions/:id` — relabel / set default
- `POST /api/ingestion-jobs` — start ingestion (mode + payload per Section 8.3-8.5)
- `GET /api/ingestion-jobs/:id` — status + aggregate counts
- `GET /api/site-configs` — list enabled sites for Mode 3 dropdown
- `POST /api/analyses` — request analysis for (jobOfferId, cvVersionId) → 202 + id
- `GET /api/analyses/:id` — poll status/result
- `GET /api/analyses?jobOfferId=` — list analyses for side-by-side comparison

## 10. Async Pipeline — End-to-End Sequence

1. Next.js API route creates `Analysis` row (`status=PENDING`) via Prisma,
   returns `202` with `analysisId` immediately.
2. Next.js pushes a message to SQS (`analysis-intake` queue) with `analysisId`.
3. SQS-triggered Step Functions execution (`AnalysisWorkflow`) starts;
   `Analysis.status -> QUEUED`, `stepFunctionExecutionArn` recorded.
4. **EnsureCVParsed** — Lambda checks `CVVersion.parseStatus`; if not `PARSED`,
   runs `CVExtractionAgent`, caches result on `CVVersion.structuredData`.
5. **EnsureOfferExtracted** — same for `JobOffer.structuredData`, via
   `JobOfferExtractionAgent`.
6. **RunComparisonCrew** (`waitForTaskToken`) — Fargate task runs the CrewAI
   crew: `ComparisonAnalysisAgent` (matched/missing skills, strengths/
   weaknesses, score) then `RecommendationWriterAgent` (`improvement_suggestions`
   + `summary`). `Analysis.status -> RUNNING_CREW`. LLM calls go through the
   configurable provider interface (Claude or OpenAI per `LLM_PROVIDER`).
7. On completion, the task writes validated JSON (Section 8.6 schema) to
   `s3://{bucket}/analysis-results/{analysisId}.json`, calls `SendTaskSuccess`
   with the S3 key. `Analysis.status -> AWAITING_RESULT`.
8. S3 `ObjectCreated` on `analysis-results/` triggers `PersistResultLambda`.
9. `PersistResultLambda` reads/validates the JSON, upserts `resultJSON`,
   `matchScore`, sets `status=COMPLETED`, `completedAt=now()` via SQLAlchemy —
   the sole writer of terminal analysis state.
10. Any step failure → Step Functions `Catch` sets `status=FAILED` +
    `errorMessage`, after up to 3 retries with exponential backoff (base 2s).
11. Frontend polls `GET /api/analyses/:id` every 3s (stop after terminal state,
    or a 2-minute soft-timeout warning) and renders results on `COMPLETED`.

## 11. Non-Functional Requirements

- **Security:** encryption at rest (S3, RDS) and in transit (TLS); secrets via
  AWS Secrets Manager, never hardcoded; per-user data isolation enforced at
  the query layer.
- **Cost control:** `INGESTION_MAX_OFFERS=25` default; per-user daily analysis
  cap (configurable); LLM provider/model chosen via env var so cost/quality
  tradeoffs are adjustable without code changes.
- **Observability:** structured logs across Lambda/Fargate steps;
  `PipelineEvent` table as an application-level trail.
- **Resilience:** no step silently swallows failure — every terminal state
  (`FAILED`, `PARTIALLY_COMPLETED`) carries an `errorMessage`.

## 12. Milestones & Phasing

Each task must carry an explicit ID and a literal, runnable verification
command when implemented. See `progress.txt` for the live checklist with
per-task IDs.

**M0 — Monorepo Bootstrap**
- pnpm/turborepo workspace + Next.js skeleton + `packages/prisma` with only
  NextAuth tables + local docker-compose Postgres + CI skeleton.
- Verify: `pnpm install` exits 0; `pnpm --filter web dev` serves 200 on `/`;
  `pnpm prisma migrate dev` succeeds against docker Postgres.

**M1 — Auth + CV Upload/Versioning** ✅ COMPLETE
- NextAuth (Email/Google/LinkedIn) + `CVVersion` model + S3 presigned upload +
  CV list UI.
- Verify: sign-in via Email provider works in dev; uploading a 2nd CV creates
  a 2nd row without overwriting the 1st; non-PDF/DOCX upload rejected with a
  clear error; S3 object exists at the documented key.

**M2 — Mode 1 Ingestion + Basic Analysis (simplified pipeline)** ✅ COMPLETE
- Single-URL scrape + extraction + a CrewAI comparison call against a fixture
  HTML page (deterministic, no live scrape dependency in tests).
- Verify: given the fixture URL, `Analysis.status=COMPLETED` with `resultJSON`
  matching the Section 8.6 schema; UI renders all 5 categories + score.

**M3 — Mode 2 Ingestion (Listing URL)** ✅ COMPLETE
- Listing extraction (generic heuristic + cap), fan-out to N `JobOffer`s
  reusing M2's pipeline, `IngestionJob` aggregate status.
- Verify: fixture listing page with 5 links produces exactly 5 linked
  `JobOffer` rows; UI shows "N/5 processed".

**M4 — Mode 3 Ingestion (Preconfigured Site + Filters) + SiteConfig adapters** ✅ COMPLETE
- Seed `SiteConfig` for all 5 sites (✅ model + migration + seed done); site
  picker + filter form UI (✅ done); URL/API construction from filters (✅ done);
  France Travail via official API (✅ done); HTML_SCRAPE selector-based
  adapters for LinkedIn/Indeed/Glassdoor/WTTJ (✅ done); per-site failure
  handling wired into a single Mode 3 orchestrator (✅ done).
- Verify: France Travail filters produce a valid API call returning >=1 offer
  end-to-end; LinkedIn/Indeed/Glassdoor/WTTJ adapters pass unit tests against
  saved fixture HTML (live scraping success is explicitly NOT a CI-required
  acceptance criterion, per anti-bot risk in Section 14).

**M5 — Async Pipeline Hardening (full S3-event-driven architecture)**
- Replace M2-M4's simplified path with SQS intake + Step Functions +
  `waitForTaskToken` + S3 result write + S3-event persistence Lambda, per
  Section 10.
- Verify: triggering analysis returns 202 without blocking; result JSON
  appears at the documented S3 key; Postgres `Analysis` reaches `COMPLETED`
  purely from the S3-event Lambda; malformed LLM output yields `FAILED` with
  `errorMessage`, never a stuck state.

**M6 — Dashboard, Multi-CV Comparison, Observability, Guardrails**
- Dashboard listing all analyses; compare one `JobOffer` against 2+
  `CVVersion`s side by side; structured logging; enforce
  `INGESTION_MAX_OFFERS` and a per-user daily analysis cap.
- Verify: side-by-side comparison renders 2 distinct `resultJSON`s for the
  same offer; exceeding a low test-configured daily cap returns a clear
  server-enforced error.

## 13. Assumptions (defaults chosen on the user's behalf, changeable)

- CV formats: PDF + DOCX only; scanned/image PDFs (needing OCR) out of scope.
- DB: RDS PostgreSQL single instance (not Aurora) for MVP.
- Multi-tenancy: standard per-user ownership checks in the application layer
  (Postgres RLS deferred, not required for MVP).
- `JobOffer` globally deduplicated by canonical URL; `IngestionJob`/`Analysis`
  are the user-scoped access-control boundary.
- Defaults: `INGESTION_MAX_OFFERS=25`, CV max size 10MB, analysis poll
  interval 3s.
- Python packaging: `uv` workspace; JS: pnpm + Turborepo; CI: GitHub Actions.

## 14. Open Risks (explicitly not silently assumed away)

- **LinkedIn/Indeed/Glassdoor scraping:** strong anti-bot measures and ToS
  restrictions on automated access. MVP treats these as best-effort HTML
  scraping behind a swappable adapter, with official APIs/partner access or a
  scraping-as-a-service provider (e.g. Bright Data, Apify) as documented
  fallback if scraping proves unviable in production. Legal/ToS review is
  required before production use and is out of this PRD's authority.
- **France Travail** has an official public API (francetravail.io) — lower
  risk, preferred over scraping.
- **Selector drift:** any site's HTML structure can change and silently break
  an adapter; fixture-based unit tests catch code regressions but not live
  drift — recommend periodic, rate-limited smoke checks with alerting.
- **CrewAI/Lambda timeout mismatch:** multi-agent LLM chains may exceed
  Lambda's 15-minute ceiling — mitigated via Step Functions
  `waitForTaskToken` + Fargate, needs validation once real latencies are
  measured.
- **LinkedIn OAuth** (Sign In with LinkedIn via OIDC) requires app approval
  through LinkedIn's developer portal, possible lead time — external
  dependency.
- **PII/GDPR:** CVs and job-search activity are sensitive personal data
  (candidate likely EU/France-based); encryption at rest/in transit and a
  data-deletion path are required; full compliance review out of scope here.
- **Cost risk:** uncapped listing/site-search ingestion could trigger many LLM
  calls; mitigated by `INGESTION_MAX_OFFERS` and a per-user daily analysis cap
  (M6), exact limits need business confirmation post-MVP.

## 15. Out of Scope

Actual IaC (Terraform/CDK) code; mobile apps; billing/payments; OCR for
scanned CVs; automated CV file rewriting; recruiter/employer-facing features;
enterprise SSO; automated legal/ToS compliance verification; real-time
(WebSocket) push updates (polling is MVP-sufficient).

## 16. Glossary

- **CVVersion:** one labeled, versioned upload of a candidate's CV.
- **JobOffer:** a single job posting, globally deduplicated by URL.
- **IngestionJob:** one ingestion request (any of the 3 modes), may produce
  1..N JobOffers.
- **Analysis:** one (JobOffer, CVVersion) comparison result.
- **SiteConfig:** data-driven adapter config for one supported job site.
- **Ralph loop:** the autonomous coding-agent loop this PRD is written for.

## 17. progress.txt Contract

`progress.txt` uses one checklist block per milestone, one line per task, each
completed line carrying a timestamp and a one-line verification summary. This
is what every fresh-context agent iteration reads first to find its next task.
See `progress.txt` at the repo root for the live, seeded checklist.
