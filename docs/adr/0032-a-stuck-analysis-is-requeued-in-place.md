# A stuck Analysis is requeued in place, and staleness is derived on read

A `docker compose restart` during a Scout run left several `Analysis` rows at `PENDING` for good. Nothing was wrong with them and nothing was coming for them: ElasticMQ holds messages in memory only (`elasticmq.conf` declares no `messages-storage`, and docker-compose.yml mounts just the read-only config), so the queued `analysis-intake` messages were gone while the rows stayed in Postgres. There is no heartbeat, lock or attempt counter anywhere in the pipeline, so no code path ever reads a non-terminal Analysis a second time.

The user-facing gap was sharper than it looks: "Relancer l'analyse" already exists in five places, gated on `TERMINAL_ANALYSIS_STATUSES` (`COMPLETED`/`FAILED`) — exactly the set that *excludes* an orphaned row. The question was not how to add a button but under what condition to show it.

We decided: the server derives a `stuck` flag on read, and `POST /v1/analyses/{id}/requeue` re-drives **the same row** — back to `PENDING`, re-enqueued, no new Analysis and no quota charged.

Why: the two halves answer each other. Deriving `stuck` server-side means the rule exists once and the client reads a boolean instead of re-deriving one from timestamps it cannot fully interpret; gating the endpoint on the same predicate makes the server the authority, so a stale client cannot spend LLM budget on a row that is actually alive.

## The rule

```
stuck = status ∉ (COMPLETED, FAILED)
        AND max(requestedAt, requeuedAt, startedAt) < now - ANALYSIS_STUCK_AFTER_MINUTES   (default 15)
```

A plain age check on the row's own clock. Nothing else — no query, no session, no global state.

### The liveness probe this replaced

The rule first shipped with a third term: a queued row (`startedAt IS NULL`) was spared unless the newest `PipelineEvent` anywhere was older than `PIPELINE_IDLE_GRACE_MINUTES`. The intent was sound — `dispatch_scout_run` fans out `SCOUT_INGESTION_MAX_OFFERS` (25) offers *per site* and the local worker drains them one at a time, so the tail of a multi-site run legitimately waits at `PENDING`, and an age-only rule declares that whole tail dead.

It was withdrawn the same day, because in practice it hid the button far more often than it protected anything:

- **The repair re-armed the probe.** Requeueing writes `requeue`, then `crew` and `persist` events. So fixing one stranded row made every *other* stranded row look alive for the next grace window. With 22 rows stranded by one restart, the button vanished for 15 minutes at exactly the moment the candidate was using it.
- **Unrelated pipelines voted.** The probe is a `max()` over the whole table, so a CV conversion (`stage='convert'`, no `analysisId`) vouched for the `analysis-intake` queue it has nothing to do with.

Measured on the dev database across one 68-minute window, those two effects left the button visible for 14 minutes total, against 22 rows that had been orphaned for ten hours.

The deeper problem is that `PipelineEvent` cannot answer the question being asked. "Is a message still queued for *this* row?" is a fact about the queue; the event trail only says whether something, somewhere, moved recently. Scoping the probe more tightly (worker stages only, `analysisId` set, `requeue` excluded) would have fixed both symptoms and still left a proxy standing in for a fact. Querying the queue's own depth would answer it properly — see **Considered options**.

So the false positive is accepted instead, and paid for where it lands: `run_crew_task` returns early on an Analysis that is already `COMPLETED` with an `s3ResultKey`, redeeming its Step Functions token on the way out. A row requeued while still legitimately queued therefore costs one duplicate message and no LLM spend.

## Considered options

- **A background reaper marking stuck rows `FAILED`.** This was the first design, and it is tempting because the existing `FAILED` gate would light up all five relaunch affordances for free. Rejected: it turns a recoverable row into a terminal one, and the relaunch it unlocks is `POST /v1/analyses`, which charges quota and leaves a dead row beside the new one. It also adds a scheduled writer to a system that had none.
- **A pure client-side age heuristic, no backend change.** Rejected even now that the rule *is* an age check: it duplicates the rule in a second language, leaves the row non-terminal for ever, and offers no server-side guard on what the requeue then costs. The client reading one boolean is the part worth keeping.
- **Asking the queue instead of the event trail** — `GetQueueAttributes` on `analysis-intake`, and treating an old `PENDING` row as orphaned when the depth is zero. This answers the actual question rather than proxying it, and has none of the feedback problems above. Not taken now: it puts an SQS round-trip on every analyses list read and makes the API depend on the queue to serve a read. Held as the upgrade if the accepted false positive ever proves expensive.
- **Scoping the probe rather than removing it** (worker stages only, `analysisId` set, `requeue` excluded). Rejected as the worst of both: it keeps a proxy signal and its whole explanation in the code, to buy back a case the duplicate-message guard already handles for free.
- **Rewriting `requestedAt` on requeue instead of adding a column.** Rejected, and this is the trap worth naming: `requestedAt` is the quota clock — `py_db.quota.analyses_requested_today` / `_this_month` count `Analysis` rows by it — as well as a filter on the admin analyses screen. Moving it would silently spend a daily and a monthly quota slot on work already paid for, which is the exact cost this change sets out to avoid.
- **Reusing `supersededById`-style supersede semantics.** Not applicable: requeue produces no second row, so there is nothing to link. docs/adr/0011's reasoning for the terminal re-run stands unchanged.

## Consequences

- **`requeue` and `POST /v1/analyses` are now two verbs for two intentions.** Requeue is "this never finished, pick it up again": same row, no quota, refused with `409 ANALYSIS_ALREADY_TERMINAL` on a finished Analysis. `POST /v1/analyses` remains the docs/adr/0011 re-run of a *terminal* Analysis: a new unlinked row, quota charged, possibly against a different CV. Neither grew a flag to do the other's job.
- **Re-clicking is bounded by the `requeuedAt` stamp**, because it is the newest term of the staleness clock. A second requeue inside the same window is refused `409 ANALYSIS_NOT_STUCK` rather than queueing a duplicate crew run. This is also why `requeue` needs no quota check of its own.
- **`startedAt` is cleared on requeue.** Otherwise the next run's `startedAt` would be a lie and, worse, an old `startedAt` would keep the row looking mid-flight to the rule above.
- **A failed enqueue is no longer a dead end.** `POST /v1/analyses` has always committed before sending, so a `send_message` failure orphaned the row permanently. Such a row is now simply stuck, and requeueable once the threshold passes — the first self-healing this class of bug has had.
- **Deciding `stuck` costs no query.** `is_analysis_stuck` is pure, so `_analysis_response` takes only `now` — passed in so every row of one response is judged against one clock. `PipelineEvent_createdAt_idx`, added for the withdrawn probe, is left in place: it is cheap and `createdAt` is the natural ordering of the busiest table in the schema.
- **A duplicate `analysis-intake` message is a no-op.** `run_crew_task` returns the existing `s3ResultKey` when the Analysis is already `COMPLETED`, and still calls `send_task_success` so the execution is not left waiting on a callback. This is what makes the age check's false positive affordable, and it also covers redeliveries the queue itself may produce.
- **The repair scales to the incident.** A restart strands rows by the dozen, so the Analyses list's bulk-actions bar carries its own requeue over the selected stuck rows — `stuck` read off each row rather than re-derived — fanned out with `Promise.allSettled` so one `409` does not abort the rest. No confirm step and no quota arithmetic, unlike the bulk Re-run beside it.
- **An abandoned `ScoutRun` is closed where it is noticed, not by a sweeper.** Both skip-on-overlap guards refused to start a run while another was `RUNNING`, so one run abandoned mid-fan-out silenced its Scout's daily schedule permanently — the failure docs/adr/0004 recorded as having "no automatic timeout/recovery in v1". `close_stale_running_runs` now runs inside those guards and marks what it steps over `FAILED`, so the run history never shows an eternal "in progress". A `RUNNING` run is safe to judge on age because that status only spans the fan-out: DB writes and SQS sends, no LLM. `PENDING` runs are left alone — they hold no lock.
- **The same failure mode remains open elsewhere.** `IngestionJob` (`RUNNING`), `CVVersion.conversionStatus` (`CONVERTING` — docs/adr/0028 already notes that "Reconvertir" answers 409 on a stuck one, so it cannot be repaired from the UI) and `GeneratedDocument` (`GENERATING`) all still strand on a restart. Deliberately out of scope here; the predicate in `py_db/stuck_analysis.py` is the shape to copy.
- **Thresholds are env-tunable** (`ANALYSIS_STUCK_AFTER_MINUTES`, default 15; `SCOUT_RUN_STUCK_AFTER_MINUTES`). Raising the first is the operator's answer if a deployment's Scout backlogs are long enough that the false positive becomes a nuisance; there is no second knob to reason about any more.
