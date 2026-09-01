# The matching flow funnels both entry screens through IngestionJob, and the multi-offer batch is derived, not an entity

The candidate reaches matching through two screens — **Analyse one offer** (a URL
plus a CVVersion) and **Analyse several offers** (a site plus filters plus a
CVVersion). Both create an `IngestionJob` (modes `SINGLE_URL` and `SITE_SEARCH`)
carrying the chosen `cvVersionId`. A new **SQS-triggered Ingestion worker** —
modelled on the existing `analysis-intake` worker — consumes `{ingestionJobId}`,
runs the already-tested discover/scrape/extract pipeline, then creates one
`Analysis` per ready `JobOffer` and enqueues it on the existing `analysis-intake`
path. `IngestionJob` gains `cvVersionId`; `Analysis` gains `ingestionJobId`. The
multi-offer **Analysis batch** is exactly "the Analyses for one `ingestionJobId`"
— no aggregate row of its own.

Why: it closes the long-standing API↔Ingestion gap (a submitted `IngestionJob`
never advanced) by reusing the async-worker pattern the codebase already runs for
analysis intake and CV conversion, and reusing `run_site_search_ingestion` and
the single-URL functions unchanged. One funnel means one code path for both
screens — the single-offer screen is the N=1 case. Deriving the batch from two
foreign keys avoids a third aggregate with its own status, lifecycle, and
rollups; the ranked batch view is a single `WHERE ingestionJobId = ?` query.

## Considered options

- **A dedicated `MatchRun` aggregate** owning the run + its Analyses + the CV.
  Rejected: it adds a lifecycle and status field that the
  `(IngestionJob, cvVersionId)` pair plus the existing `IngestionJob` rollups
  already provide, for no behaviour of its own.
- **Wiring the pipeline inline in the FastAPI `POST /v1/ingestion-jobs`
  request.** Rejected: multi-page scrape plus per-offer LLM extraction is
  minutes of work; it cannot block a synchronous request.
- **A Step Functions state machine for ingestion**, symmetric with
  `AnalysisWorkflow`. Rejected: `run_site_search_ingestion` already owns its
  retry and per-site failure contract; a plain SQS worker is enough.

## Consequences

- `IngestionMode.LISTING_URL` (paste a search-results URL) leaves the UI. The
  enum value and its pipeline code stay, dormant.
- `POST /v1/analyses` stays, now only for the path where the `JobOffer` is
  already extracted — the "offer already known" shortcut and the single-offer
  "re-run" button — creating one `Analysis` with no `IngestionJob`.
- `/ingestion-jobs/new` is replaced by the two screens; `/ingestion-jobs/{id}`
  remains as the scraping-progress drill-down the batch result view links to.
- `AnalysisWorkflow`'s `EnsureCVConverted` / `EnsureOfferExtracted` steps stay
  as guarantees but are usually no-ops on this path, since the worker has
  already converted the CV (only CONVERTED CVs are selectable) and extracted
  the offer before the `Analysis` exists.
- The per-user daily analysis cap now meets multi-offer runs: a run launches up
  to the remaining daily budget and marks the rest "not analysed — daily limit
  reached", rather than rejecting the whole run.
