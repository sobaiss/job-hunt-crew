# Scouts run in a dedicated context with a ScoutRun aggregate, and generation is user-gated

Autonomous Scouts (issue #52) needed somewhere to live. `services/scout` is a
new bounded context — the fifth, alongside Web, API, Ingestion, and Analysis
— that owns Scout scheduling and run orchestration: selecting which Scouts
are due, creating a `ScoutRun`, fanning out to the existing Ingestion
pipeline per targeted site, applying the relevance threshold once analyses
complete, and rolling up run counts/status. It does not scrape, extract,
compare, or generate documents itself — every one of those stays owned by
the context that already does it (Ingestion, Analysis), reached the same way
Ingestion and Analysis already reach each other: direct reads/writes against
the shared Postgres tables via `py_db`, not through API's HTTP surface.

## ScoutRun is a real aggregate row — distinguishing ADR 0002

ADR 0002 rejected a dedicated `MatchRun` aggregate for the "analyse several
offers" batch: `(IngestionJob, cvVersionId)` already carried that batch's
status and rollups, so a derived view (`WHERE ingestionJobId = ?`) was
enough and a third status-bearing row would have added a lifecycle nothing
needed. `ScoutRun` looks similar on the surface — it also aggregates a
multi-`IngestionJob` operation — but is different in kind, and this ADR
records that difference deliberately so the inconsistency between the two
is legible rather than accidental:

- **Scheduler-triggered, not request-triggered.** Nothing submits a
  `ScoutRun` synchronously the way a candidate submits an `IngestionJob`;
  something must be able to answer "did last night's run happen, and did it
  succeed" with no request in flight to derive that from.
- **Spans multiple `IngestionJob`s plus a later phase.** One `ScoutRun` fans
  out to one `IngestionJob` per targeted site (`sitesQueried`,
  `siteUnavailableCount`), then a downstream analysis phase
  (`offersAnalysed`, `relevantCount`, `capSkippedCount`,
  `alreadySeenCount`, `runLimitSkippedCount`) and optionally a generation
  phase (`documentsGeneratedCount`) — no single `IngestionJob` row is the
  natural owner of that whole span the way it is for the single-CVVersion
  "analyse several" batch.
- **The anchor for stats.** Per-Scout statistics (`GET /v1/scouts/{id}/stats`)
  and run history both need one row per run to query and display against;
  deriving that from a `WHERE` clause over `IngestionJob` rows created for
  unrelated reasons would be indirect and fragile.

`ScoutRun` therefore gets its own table, status enum (mirroring
`IngestionJobStatus`: `PENDING` | `RUNNING` | `PARTIALLY_COMPLETED` |
`COMPLETED` | `FAILED`), and rollup counters. The set of `Analysis` rows for
a run stays derived — `Analysis.scoutId` plus each `IngestionJob.scoutRunId`
— consistent with ADR 0002's principle that a per-offer result set doesn't
need its own join table when the owning foreign keys already identify it.

## Generation is user-gated, not automatic

`GenerationWorkflow` (docs/adr/0003) is a separate workflow from
`AnalysisWorkflow`, with its own `generation-intake` queue, triggered only by
an explicit "Generate documents" action on a find — never automatically when
a `ScoutRun` produces a relevant find. Two LLM documents per find is the
highest marginal cost in the whole Scout loop; gating it behind a click keeps
that cost proportional to documents the candidate actually wants, while
discovery and matching (the autonomous, high-value part) run fully
unattended. Auto-generation — e.g. always generating for every relevant find
above some higher threshold — is a plausible future revisit once real
match-score distributions and generation quality have been observed in
practice, but is explicitly not this slice's design.

## Consequences

- `services/scout` reads and writes `Scout`, `ScoutRun`, `IngestionJob`,
  `Analysis`, and `SiteConfig` directly via `py_db` — the same
  direct-Postgres pattern `services/ingestion` and `services/analysis`
  already use, not a new precedent.
- `dispatch_scout_run` is the one new orchestration seam this context adds;
  it does not itself scrape, extract, or analyse — it creates
  `IngestionJob`s and lets the existing `ingestion-intake` →
  `analysis-intake` pipeline do the rest, the same fan-out the manual
  "analyse several offers" screen triggers.
- A `ScoutRun` stuck `RUNNING` from a crashed worker blocks that Scout's next
  scheduled tick (skip-on-overlap) until it is manually resolved — no
  automatic timeout/recovery in v1.
- `GeneratedDocument.scoutRunId` is nullable and denormalised purely for
  attribution ("which run produced the find this document came from"); it is
  not a second aggregate — see ADR 0003 for `GeneratedDocument`'s own status.
