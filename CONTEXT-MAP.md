# Context Map

## Contexts

- [Web](./apps/web/CONTEXT.md): the candidate-facing Next.js app and its BFF proxy — the only context a browser talks to
- [API](./services/api/CONTEXT.md): sole owner of Postgres/S3/SQS for synchronous, user-facing data — CRUD, presigned uploads, SQS enqueue
- [Ingestion](./services/ingestion/CONTEXT.md): turns an ingestion request into scraped, structured JobOffers
- [Analysis](./services/analysis/CONTEXT.md): the CrewAI pipeline comparing a JobOffer against a CVVersion

## Relationships

- **Web → API**: every BFF route forwards to API's `/v1/*`/`/internal/*` surface over HTTP, authenticated by a shared internal secret plus an `X-User-Id` header. Web holds no direct connection to Postgres, S3, or SQS.
- **API → Analysis**: `POST /v1/analyses` sends an SQS message that Analysis's intake handler consumes to start an AnalysisWorkflow execution.
- **Ingestion → Analysis**: Ingestion's fan-out pipeline calls Analysis's `JobOfferExtractionAgent` directly (an in-process Python import, not a queue) to turn scraped HTML into a JobOffer's structured data. AnalysisWorkflow's own prerequisite steps call that same agent, plus `CVExtractionAgent`, for the Analysis pipeline's own needs — one shared extraction step, two callers.
- **Analysis/Ingestion → Postgres/S3**: unlike Web, Analysis and Ingestion don't go through API's HTTP surface — both write directly to the same Postgres tables and S3 buckets API owns, via the shared `py-db` SQLAlchemy models. This is the deliberate split between the synchronous CRUD path (Web → API → Postgres) and the async pipeline path (SQS/Step Functions → Lambda/Fargate workers → Postgres directly).
- **API ↔ Ingestion — known gap, not a decision**: `POST /v1/ingestion-jobs` only creates the `IngestionJob` row. It never calls Ingestion's pipeline. Every mode's scrape/extract pipeline (`run_site_search_ingestion` and the Mode 1/2 functions it wraps) exists and is tested, but nothing in the running system invokes it outside of tests — confirmed across the M3/M4/M7 build notes in `progress.txt`, most explicitly M7-T11/T12/T18. A candidate submitting an ingestion request today gets a `PENDING` row that nothing ever advances.
