# Context Map

## Contexts

- [Web](./apps/web/CONTEXT.md): the candidate-facing Next.js app and its BFF proxy — the only context a browser talks to
- [API](./services/api/CONTEXT.md): sole owner of Postgres/S3/SQS for synchronous, user-facing data — CRUD, presigned uploads, SQS enqueue
- [Ingestion](./services/ingestion/CONTEXT.md): turns an ingestion request into scraped, structured JobOffers
- [Analysis](./services/analysis/CONTEXT.md): the CrewAI pipeline comparing a JobOffer against a CVVersion

## Relationships

- **Web → API**: every BFF route forwards to API's `/v1/*`/`/internal/*` surface over HTTP, authenticated by a shared internal secret plus an `X-User-Id` header. Web holds no direct connection to Postgres, S3, or SQS.
- **API → Analysis**: a requested comparison reaches AnalysisWorkflow one of two ways — `POST /v1/analyses` sends an SQS message directly (used when the JobOffer is already extracted, e.g. a re-run), or an Ingestion worker creates the `Analysis` and sends that message once it has scraped and extracted the offer. Either way Analysis's intake handler consumes it and starts an AnalysisWorkflow execution. `POST /v1/cv-versions/{id}/convert` likewise sends an SQS message that an Analysis handler consumes to build that CVVersion's Markdown rendition (Conversion).
- **Ingestion → Analysis**: Ingestion's fan-out pipeline calls Analysis's `JobOfferExtractionAgent` directly (an in-process Python import, not a queue) to turn scraped HTML into a JobOffer's structured data. AnalysisWorkflow's own prerequisite steps call that same agent for the Analysis pipeline's own needs — one shared extraction step, two callers. Its CV-side prerequisite instead runs Conversion (`EnsureCVConverted`), the same code the API context triggers on demand via SQS.
- **Analysis/Ingestion → Postgres/S3**: unlike Web, Analysis and Ingestion don't go through API's HTTP surface — both write directly to the same Postgres tables and S3 buckets API owns, via the shared `py-db` SQLAlchemy models. This is the deliberate split between the synchronous CRUD path (Web → API → Postgres) and the async pipeline path (SQS/Step Functions → Lambda/Fargate workers → Postgres directly).
- **API → Ingestion**: `POST /v1/ingestion-jobs` sends an SQS message that an Ingestion worker consumes to run the discover/scrape/extract pipeline for that `IngestionJob`, then creates one Analysis per ready JobOffer against the CVVersion the job carries and hands each to the **API → Analysis** path above. Decided in ADR 0002; **not yet built** — until it is, a submitted `IngestionJob` stays `PENDING`. The scrape/extract pipeline it will call (`run_site_search_ingestion` and the single-URL functions it wraps) already exists and is tested, but only tests invoke it — confirmed across the M3/M4/M7 build notes in `progress.txt`, most explicitly M7-T11/T12/T18.
