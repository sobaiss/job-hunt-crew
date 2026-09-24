# A stuck Analysis is requeued in place, and staleness is derived on read

A `docker compose restart` during a Scout run left several `Analysis` rows at `PENDING` for good. Nothing was wrong with them and nothing was coming for them: ElasticMQ holds messages in memory only (`elasticmq.conf` declares no `messages-storage`, and docker-compose.yml mounts just the read-only config), so the queued `analysis-intake` messages were gone while the rows stayed in Postgres. There is no heartbeat, lock or attempt counter anywhere in the pipeline, so no code path ever reads a non-terminal Analysis a second time.

The user-facing gap was sharper than it looks: "Relancer l'analyse" already exists in five places, gated on `TERMINAL_ANALYSIS_STATUSES` (`COMPLETED`/`FAILED`) — exactly the set that *excludes* an orphaned row. The question was not how to add a button but under what condition to show it.

We decided: the server derives a `stuck` flag on read, and `POST /v1/analyses/{id}/requeue` re-drives **the same row** — back to `PENDING`, re-enqueued, no new Analysis and no quota charged.

Why: the two halves answer each other. Deriving `stuck` server-side means the rule exists once and the client reads a boolean instead of re-deriving one from timestamps it cannot fully interpret; gating the endpoint on the same predicate makes the server the authority, so a stale client cannot spend LLM budget on a row that is actually alive.

## The rule

```
stuck = status ∉ (COMPLETED, FAILED)
        AND max(requestedAt, requeuedAt, startedAt) < now - ANALYSIS_STUCK_AFTER_MINUTES
        AND (startedAt IS NOT NULL  OR  max(PipelineEvent.createdAt) < now - PIPELINE_IDLE_GRACE_MINUTES)
```

That last term is the whole reason this is not a plain age check, and it is the part worth remembering:

- `startedAt` **set** (`RUNNING_CREW`/`AWAITING_RESULT`) means a worker was inside this row, so nothing is queued behind it — an overdue clock can only mean the process died.
- `startedAt` **null** (`PENDING`/`QUEUED`) means the row may simply be waiting its turn. `dispatch_scout_run` fans out `SCOUT_INGESTION_MAX_OFFERS` (25) offers *per site* and the local worker drains them one at a time, so the tail of a multi-site Scout run legitimately waits hours at `PENDING`. An age-only rule would declare that whole tail dead and invite the candidate to pay for re-running work that was about to happen.

`PipelineEvent` is the liveness probe because `record_pipeline_event` commits on its own row, independently of the caller's work — the trail survives the crash it documents. The probe is deliberately *global* ("is anything moving?"), not per-analysis: a queued row has no events of its own, which is precisely the case being judged.

## Considered options

- **A background reaper marking stuck rows `FAILED`.** This was the first design, and it is tempting because the existing `FAILED` gate would light up all five relaunch affordances for free. Rejected: it turns a recoverable row into a terminal one, and the relaunch it unlocks is `POST /v1/analyses`, which charges quota and leaves a dead row beside the new one. It also adds a scheduled writer to a system that had none.
- **A pure client-side age heuristic, no backend change.** Rejected: it duplicates the rule in a second language, cannot see the `PipelineEvent` liveness signal (so it would get the Scout backlog wrong), leaves the row non-terminal for ever, and offers no server-side guard on what the requeue then costs.
- **Rewriting `requestedAt` on requeue instead of adding a column.** Rejected, and this is the trap worth naming: `requestedAt` is the quota clock — `py_db.quota.analyses_requested_today` / `_this_month` count `Analysis` rows by it — as well as a filter on the admin analyses screen. Moving it would silently spend a daily and a monthly quota slot on work already paid for, which is the exact cost this change sets out to avoid.
- **Reusing `supersededById`-style supersede semantics.** Not applicable: requeue produces no second row, so there is nothing to link. docs/adr/0011's reasoning for the terminal re-run stands unchanged.

## Consequences

- **`requeue` and `POST /v1/analyses` are now two verbs for two intentions.** Requeue is "this never finished, pick it up again": same row, no quota, refused with `409 ANALYSIS_ALREADY_TERMINAL` on a finished Analysis. `POST /v1/analyses` remains the docs/adr/0011 re-run of a *terminal* Analysis: a new unlinked row, quota charged, possibly against a different CV. Neither grew a flag to do the other's job.
- **Re-clicking is bounded by the `requeuedAt` stamp**, because it is the newest term of the staleness clock. A second requeue inside the same window is refused `409 ANALYSIS_NOT_STUCK` rather than queueing a duplicate crew run. This is also why `requeue` needs no quota check of its own.
- **`startedAt` is cleared on requeue.** Otherwise the next run's `startedAt` would be a lie and, worse, an old `startedAt` would keep the row looking mid-flight to the rule above.
- **A failed enqueue is no longer a dead end.** `POST /v1/analyses` has always committed before sending, so a `send_message` failure orphaned the row permanently. Such a row is now simply stuck, and requeueable once the threshold passes — the first self-healing this class of bug has had.
- **The liveness probe runs once per analyses read, not per row.** `_analysis_response` takes `now` and `last_pipeline_activity` as arguments for that reason, and `PipelineEvent_createdAt_idx` exists to keep `max(createdAt)` cheap on the busiest table in the schema. `GET /scouts/{id}/finds` passes `None` because every row it serialises is `COMPLETED` and short-circuits.
- **An abandoned `ScoutRun` is closed where it is noticed, not by a sweeper.** Both skip-on-overlap guards refused to start a run while another was `RUNNING`, so one run abandoned mid-fan-out silenced its Scout's daily schedule permanently — the failure docs/adr/0004 recorded as having "no automatic timeout/recovery in v1". `close_stale_running_runs` now runs inside those guards and marks what it steps over `FAILED`, so the run history never shows an eternal "in progress". A `RUNNING` run is safe to judge on age because that status only spans the fan-out: DB writes and SQS sends, no LLM. `PENDING` runs are left alone — they hold no lock.
- **The same failure mode remains open elsewhere.** `IngestionJob` (`RUNNING`), `CVVersion.conversionStatus` (`CONVERTING` — docs/adr/0028 already notes that "Reconvertir" answers 409 on a stuck one, so it cannot be repaired from the UI) and `GeneratedDocument` (`GENERATING`) all still strand on a restart. Deliberately out of scope here; the predicate in `py_db/stuck_analysis.py` is the shape to copy.
- **Thresholds are env-tunable** (`ANALYSIS_STUCK_AFTER_MINUTES`, `PIPELINE_IDLE_GRACE_MINUTES`, `SCOUT_RUN_STUCK_AFTER_MINUTES`), all defaulting to minutes rather than hours precisely because the idle-grace term makes a short threshold safe.
