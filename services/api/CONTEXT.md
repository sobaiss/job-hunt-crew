# API

The FastAPI service that is the sole owner of Postgres, S3, and SQS for synchronous, user-facing data — CRUD, presigned uploads, SQS enqueue. Reachable only from the [Web](../../apps/web/CONTEXT.md) context's BFF proxy, authenticated by a shared internal secret. Defines the core entities the [Ingestion](../ingestion/CONTEXT.md) and [Analysis](../analysis/CONTEXT.md) contexts read and write directly against the same tables.

## Language

**User**:
The account record for one candidate, identified by email, keyed by the canonical `userId` every other entity here is scoped to.
_Avoid_: Candidate, account — "candidate" names the persona in product conversations; `User` is the row every context actually references.

**CVVersion**:
One labeled, versioned upload of a candidate's CV (PDF, DOCX, Markdown, or plain text). Exactly one per user may be the default; each carries a Markdown rendition and its `conversionStatus`.
_Avoid_: Resume, CV file

**Markdown rendition**:
The canonical Markdown form of one CVVersion, in `CVVersion.markdownContent` — the exact text the Analysis context's comparison reads. It is the uploaded file itself for a Markdown upload, or the output of the Analysis context's Conversion otherwise; the candidate sees it read-only.
_Avoid_: Parsed CV, CV structured data, preview

**JobOffer**:
One job posting, deduplicated globally by its source URL — not owned by any single user, since the same posting is relevant to many candidates.
_Avoid_: Job posting, listing — "listing" means something else here, see `IngestionJob`.

**IngestionJob**:
One user-initiated request to discover and process job offers, in one of three modes (a single offer URL, a listing URL, or a preconfigured site plus filters). Fans out into 1..N linked JobOffers.
_Avoid_: Ingestion request, scrape job

**SiteConfig**:
The data-driven adapter configuration for one supported job site — selectors or an API endpoint, plus risk and enablement flags — that a site-search `IngestionJob` reads to know how to query that site.
_Avoid_: Site adapter — that's the Ingestion-context code that reads a SiteConfig, not the config row itself.

**Analysis**:
One requested comparison of a JobOffer against a CVVersion, tracked from request through its terminal completed/failed state.
_Avoid_: Comparison, report

**Match score**:
An Analysis result's 0-100 fit rating between a CVVersion and a JobOffer.

**PipelineEvent**:
One append-only log row recording a single pipeline stage's start, success, or failure — the one observability trail shared by the Ingestion and Analysis contexts.
_Avoid_: Audit log

**Internal API secret**:
The shared header value that authenticates every call into this context, paired with an `X-User-Id` header this context trusts rather than independently verifying. An accepted MVP boundary, not a signed-request scheme.
_Avoid_: API key
