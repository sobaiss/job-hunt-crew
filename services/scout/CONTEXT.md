# Scout

Owns autonomous Scout scheduling and run orchestration: deciding which
Scouts are due, fanning a due Scout out into the existing [Ingestion](../ingestion/CONTEXT.md)
pipeline per targeted site, and rolling up run counts and status once
[Analysis](../analysis/CONTEXT.md) completes each offer. Reads and writes
the same Postgres tables [API](../api/CONTEXT.md) owns directly via
`py_db`, independent of API's HTTP surface — the same direct-database
pattern Ingestion and Analysis already use. It does not scrape, extract,
compare, or generate documents itself; those stay owned by the contexts
that already do them. `Scout`, `ScoutRun`, `GeneratedDocument`,
`Application`, `StatusEvent`, relevance threshold, and relevant find are
defined in [API](../api/CONTEXT.md)'s context; this glossary covers only
the orchestration vocabulary specific to this context. See docs/adr/0004.

## Language

**Due**:
A Scout is due for its daily run when it is `ACTIVE` and `lastRunAt` is
`None` or before today's scheduled hour, and now is past that hour —
`is_scout_due` (`py_db.scout_schedule`), a small pure predicate covering
exactly this and nothing about how many days were missed. A Scout with a
`RUNNING` `ScoutRun` is excluded at selection time (skip-on-overlap), not by
the predicate itself. There is no backfill for a missed day: once
`lastRunAt` moves past today's hour, the Scout simply isn't due again until
tomorrow's, however many days it slipped before that.
_Avoid_: Overdue, scheduled — "due" is the term the predicate and this
glossary use.

**Scheduler tick**:
One sweep that selects every due Scout and dispatches a run for each. In
production, one EventBridge Scheduler rule fires at a fixed UTC hour and its
target does this directly; locally, `run_scheduler_tick_once` is called on a
fixed interval by `ingestion.local_worker` as a stand-in for that rule. Real
IaC for the EventBridge rule is out of scope per the PRD — only the target's
logic and the local stand-in are built.
_Avoid_: Cron, poll loop — the local interval call is a dev-only stand-in
for the production rule, not the design itself.

**dispatch_scout_run**:
The one orchestration seam this context adds, modelled on Ingestion's own
intake handler: given a `ScoutRun` id, resolves the Scout, no-ops on
overlap or a non-`ACTIVE` Scout, creates one `SITE_SEARCH` `IngestionJob`
per targeted *enabled* site (carrying the Scout's `cvVersionId`, `filters`,
and this run's id) and enqueues each on the existing `ingestion-intake`
queue, then rolls the run up to `COMPLETED` / `PARTIALLY_COMPLETED` /
`FAILED` from how many targeted sites were unavailable.
_Avoid_: Scout pipeline — "pipeline" is reserved for the scrape/extract/
compare stages Ingestion and Analysis own; this context only dispatches
into them, it doesn't run them.

**Site unavailable**:
A Scout's targeted site being missing from `SiteConfig` or present but
`enabled=false` at dispatch time. Counted on the `ScoutRun`
(`siteUnavailableCount`) and skipped rather than failing the whole run — a
run where every targeted site is unavailable is the one case that marks the
run `FAILED`.

**Skip-on-overlap**:
A Scout with a `RUNNING` `ScoutRun` is excluded from both the next
scheduler tick's due-selection and from `dispatch_scout_run` itself (a
second dispatch for the same Scout while one is `RUNNING` is a no-op,
leaving the newer run row untouched for an operator to see) — runs for one
Scout never pile up or run concurrently. An **abandoned** run does not
count as in flight: both guards go through `stale_runs.close_stale_running_runs`,
which marks any `RUNNING` run older than `SCOUT_RUN_STUCK_AFTER_MINUTES`
as `FAILED` and steps over it. Without that, a worker killed mid-fan-out
would silence its Scout's schedule permanently — the failure docs/adr/0004
recorded as having no automatic recovery in v1. See Stale run below.

**Stale run**:
A `ScoutRun` left at `RUNNING` by a dead worker. Safe to judge on age alone,
unlike an Analysis, because `RUNNING` only spans `dispatch_scout_run`'s
fan-out — DB writes and SQS sends, no LLM call — so seconds of work, and
`is_scout_run_stale` (`py_db/scout_schedule.py`) needs no liveness probe.
Closed lazily, inside the Skip-on-overlap guards where the answer is needed,
rather than by a background sweeper; closing it on the way past also keeps
the run history from showing an eternal "in progress". A `PENDING` run is
never stale: it was created but never dispatched, and holds no lock over the
Scout. See docs/adr/0032.
_Avoid_: Stuck run (fine in prose, but "stuck" is the [API](../../services/api/CONTEXT.md) context's term for an Analysis, which is a different predicate), Timed-out run, Zombie run
