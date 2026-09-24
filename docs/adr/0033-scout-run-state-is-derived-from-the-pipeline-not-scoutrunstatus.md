# Scout run state is derived from the pipeline, not from `ScoutRun.status`

The Scouts table and the Scout panel gave a candidate no way to tell whether a Scout was working. Clicking "Lancer maintenant" swapped the button to a spinner for the few hundred milliseconds the `POST` took, then put it back — so the honest reading of the screen was "nothing is happening" while the Scout was in fact churning through fifty offers. The candidate's only feedback was a second click, which the one-hour rate limit answered with a red 429.

The obvious fix is to surface `ScoutRun.status`. It does not work, and the reason is worth writing down because the next reader will reach for it too: `RUNNING` spans only `dispatch_scout_run`'s fan-out — DB writes and SQS sends, no LLM call — so it lasts seconds, and the run is stamped `COMPLETED` before a single offer has been scraped. A badge driven by it would blink for two seconds and then read "Terminé" for the twenty minutes that actually matter.

We decided: **run state is derived on read, at the Scout level, from the pipeline rows the Scout's runs produced** — not from `ScoutRun.status`, and not from a run at all. `ScoutResponse` gains three fields:

```
runState          IN_FLIGHT | BLOCKED | FAILED | DEGRADED | OK | NEVER_RUN
runStateSince     datetime | null     -- the clock behind "en cours depuis 12 min"
blockedAnalysisIds  string[]          -- empty unless runState would be BLOCKED
```

The server owns the classification, the client renders it. This follows the precedent docs/adr/0032 set for `stuck`: the rule exists once, in one language, and the Web reads the answer instead of re-deriving it from timestamps it cannot fully interpret.

## The rule

**In flight** — any of three things, because the work passes through three shapes and a gap between any two of them would read as "nothing is happening":

1. the latest `ScoutRun` is `PENDING`, or `RUNNING` and not stale — this is the fan-out itself, and it is what makes the badge appear on the click rather than seconds later once the first row lands;
2. the Scout has a non-terminal `IngestionJob` on one of its runs — the scrape/extract phase;
3. the Scout has a non-terminal `Analysis` (by the indexed `Analysis.scoutId`) that is **not blocked** by the predicate below — the long phase.

An `IngestionJob` goes terminal when scraping finishes, while the `Analysis` rows it created are only then starting the expensive part, so (2) and (3) are both needed; neither alone spans a run.

**Blocked** — a two-term predicate, and the term that splits it is `startedAt`:

```
blocked = status ∉ (COMPLETED, FAILED)
          AND ( startedAt IS NOT NULL
                AND max(requestedAt, requeuedAt, startedAt) < now - ANALYSIS_STUCK_AFTER_MINUTES        (15)
              OR startedAt IS NULL
                AND max(requestedAt, requeuedAt)            < now - SCOUT_QUEUED_BLOCKED_AFTER_MINUTES  (120) )
```

A row that was picked up and then stopped advancing is broken after fifteen minutes. A row that was **never** picked up is the legitimate tail of a fan-out — `SCOUT_INGESTION_MAX_OFFERS` is 25 *per site* and the local worker drains one at a time — so it counts as in flight until a much longer ceiling.

**Blocked is a strict subset of stuck.** Both terms are at or past `ANALYSIS_STUCK_AFTER_MINUTES`, so every blocked `Analysis` also satisfies `is_analysis_stuck`. This is load-bearing, not incidental: it is what lets the Scout panel fan `POST /v1/analyses/{id}/requeue` over `blockedAnalysisIds` without any of them coming back `409 ANALYSIS_NOT_STUCK`. Widening `blocked` past `stuck` would break that button silently.

The remaining states read off the latest run:

- `FAILED` when it is `FAILED`, **or** when it is still `RUNNING` and `is_scout_run_stale` says a worker abandoned it mid-fan-out. Deriving `FAILED` for a stale run is not an overload: it anticipates, by exactly one guard, the write `close_stale_running_runs` will make to that same row the next time either skip-on-overlap guard passes it. The read and the eventual row therefore agree, and a dead worker never reads as "À jour" while its Scout's schedule sits silenced. Without this term a run that died before creating its first `IngestionJob` would fall through every other branch and land on `OK` — the exact opposite of the truth.
- `DEGRADED` when it is `PARTIALLY_COMPLETED`, or reported failed offers.
- `OK` otherwise; `NEVER_RUN` when `lastRunAt` is null.

**`runStateSince`** is the oldest clock among the rows that produced the state, not the latest run's own — because the unit is the Scout, the honest answer to "depuis combien de temps" is when this stretch of work began, wherever it began. For `IN_FLIGHT` that is the minimum over whichever of the three branches fired (`ScoutRun.startedAt` falling back to `createdAt`; `IngestionJob.createdAt`; `Analysis.requestedAt`). For `BLOCKED` it is the oldest blocked row's own clock, so the tooltip can say how long it has been wedged. For `FAILED`, `DEGRADED`, `OK` and `NEVER_RUN` it is `null`: those states already have a date on screen in the adjacent Last-run column, and a second, subtly different one would invite the reader to reconcile them.

## Precedence, in one place

Read in this order, first match wins — the order is `IN_FLIGHT` first for the reason under **Considered options** below:

```
IN_FLIGHT  →  BLOCKED  →  FAILED  →  DEGRADED  →  NEVER_RUN  →  OK
```

`NEVER_RUN` sits before `OK` only so a Scout that has never run is never reported as fine; in practice the two are mutually exclusive.

## Two orderings, deliberately different

A reader will assume there is one list. There are two, and conflating them produces a column that hides exactly what it was built to show.

- **Precedence** — which state wins when several hold at once, the order given under **Precedence, in one place** above. Work happening now outranks a verdict inherited from the previous run.
- **Sort rank** — which rows rise when the column is sorted: `BLOCKED`, `FAILED`, `DEGRADED`, `IN_FLIGHT`, `OK`, `NEVER_RUN`. Worst first, because "show me what's wrong" is the reason to sort it.

The sort rank is coded explicitly rather than left to the labels. Alphabetical order on the French strings happens to put the worst state second (`À jour` < `Bloqué` < `Dégradé` < `Échec` < `En cours`), which would work almost always and break the day someone rewords a badge.

## Considered options

- **`ScoutRun.status` directly.** Rejected for the reason above: it describes the fan-out, not the work. Kept, unchanged, as the run history's own vocabulary.
- **Arithmetic over the counters already rolled up on `ScoutRun`** (`offersAnalysed + failedCount + alreadySeen + skipped < offersDiscovered`). Tempting: zero new joins, all columns already progressively maintained by `py_db/scout_rollup.py`. Rejected because the equality can never be reached if one row is lost, leaving the badge lit for ever, and because nobody will be able to debug that arithmetic in six months. The cost of the rejection is the two grouped queries below.
- **The latest `ScoutRun` as the unit, instead of the Scout.** Conceptually cleaner — docs/adr/0004 makes `ScoutRun` the aggregate, and `ScoutRun.startedAt` is an obvious clock. Rejected on faithfulness first: a straggler from the previous run *is* work in progress, and scoping to the latest run would report the Scout idle while its worker is busy. The cost argument is real but smaller than it looks, and worth stating accurately so nobody re-derives it wrongly: the latest run per Scout has to be fetched either way, for the `FAILED`/`DEGRADED`/`OK` branches. What the Scout-level unit actually saves is one join — reaching `Analysis` by its own indexed `scoutId` instead of through `IngestionJob.scoutRunId`, which is the path the schema would force, since `Analysis` carries `scoutId` but not `scoutRunId`.
- **Reusing `is_analysis_stuck` unchanged for the blocked term.** Rejected, and this is the finding that shaped the predicate. docs/adr/0032 *accepts* that the rule flags the legitimately-queued tail of a fan-out, and pays for the false positive where it lands: offering "Relancer" on a live row costs one duplicate message and no LLM spend. Aggregated into a per-Scout badge that false positive stops being cheap — a healthy two-site run is 50 serially-drained analyses, so the tail is "stuck" long before the run ends and the column would be red on every healthy Scout, permanently. The `startedAt` split is the distinction docs/adr/0032 wanted from `PipelineEvent` and could not get; here it is free, because `startedAt` is on the row itself. No proxy, no global state, no query.
- **Component fields on `ScoutResponse`** (`inFlightSince`, `blockedCount`, `lastRunOutcome`, …) with the client composing them. Rejected: it puts the precedence rule in TypeScript, so the Admin scouts table would have to re-implement it to show the same column. With one enum, that table reads `runState` and is done.
- **A single enum plus a second staleness boolean on `AnalysisResponse`.** This was the alternative to carrying `blockedAnalysisIds` on the Scout. Rejected as the worst available outcome: two near-identical blocked/stuck predicates on the same row, one gating a button and one gating a badge, guaranteed to drift, with no way for a reader to know which is authoritative.
- **Severity-first precedence** (`BLOCKED` > … > `IN_FLIGHT`). Rejected: it hides `IN_FLIGHT` behind a `DEGRADED` inherited from the previous run — suppressing, with history, the one fact the change exists to show.

## Consequences

- `GET /v1/scouts` gains three queries on top of `_relevant_finds_counts_by_scout`: the latest `ScoutRun` per Scout, non-terminal `Analysis` rows grouped by `scoutId`, and non-terminal `IngestionJob` rows grouped by Scout through `ScoutRun`. All three run against existing indexes (`ScoutRun_scoutId_idx`, `Analysis_scoutId_idx`, `IngestionJob_scoutRunId_idx`) and must stay grouped — one query for the whole list, never one per row, the rule `_relevant_finds_counts_by_scout` already exists to enforce. Four screens consume this endpoint — Dashboard, Applications, CV versions, Scouts — and three of them need none of it.
- Polling is therefore opt-in: `useScouts({ poll: true })`, enabled only by `/scouts`, and only while at least one row is in flight. Putting a `refetchInterval` on the shared hook would make three screens pay for a column they do not render.
- `blockedAnalysisIds` is a variable-length array on a list response. Empty in the normal case; bounded by 25 × targeted sites in the worst.
- **Two of the three red causes are not repairable by the candidate**, though they collapse into two badges. `BLOCKED` is repairable — the Scout panel offers "Relancer les N analyses bloquées", fanning the existing per-row requeue with no quota charged. A stale `RUNNING` run closes itself at the next guard (docs/adr/0032's lazy `close_stale_running_runs`), and a `FAILED` run caused by a disabled `SiteConfig` needs an Administrator. For those two the interface can only explain — which is why `BLOCKED` and `FAILED` stay separate badges instead of merging into one "Problème", and why the badge carries a tooltip rather than leaving the panel as the only explanation.
- `is_analysis_stuck`, `AnalysisResponse.stuck`, and the requeue endpoint's own gate are untouched. Changing them would reopen docs/adr/0032.
- The Admin scouts table is deliberately left out of this change. It reaches Scouts through a separate endpoint and row type (`AdminScoutRow`); with the rule server-side, adding the column there later is wiring, not design.
