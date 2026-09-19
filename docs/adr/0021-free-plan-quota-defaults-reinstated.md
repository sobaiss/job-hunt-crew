# FREE plan's PlanQuotaDefault values are reinstated, reversing "Free is free"

The migration that introduced Subscription (`20260918130000`, #153) nulled every `free` `PlanQuotaDefault` row to unlimited ("Free is free") as a side effect bundled into that migration, justified only by a migration comment — no ADR of its own ever recorded why. An unlimited-duration, unlimited-quota FREE plan turned out to be a real product problem: nothing bounds cost or abuse on a tier anyone can hold forever. FREE's `PlanQuotaDefault` reverts to the same numeric ceilings it had before that migration — 2 active Scouts, 15 daily Analyses, 300 monthly Analyses, 5 daily GeneratedDocuments — unchanged from the original seed in `20260917190236`. STANDARD (5/50/1000/20) and PREMIUM (15/150/3000/60) were never touched by "Free is free" and are untouched here too.

## Considered options

- Keep FREE unlimited but bolt on a separate abuse-control mechanism (rate limiting, manual review, etc.) — rejected: `PlanQuotaDefault`/`QuotaOverride` is already the tier's single mechanism for exactly this (docs/adr/0014); standing up a second one duplicates machinery that already exists for this purpose.
- Choose new numeric ceilings instead of restoring the pre-migration seed values — rejected: no new evidence makes a different number more defensible than the original seed, so reusing it avoids re-litigating figures nobody has data to improve on.

## Consequences

- `effective_quota` resolves live and is never cached (docs/adr/0018), so this applies to every existing FREE user immediately on deploy, not just new signups. A FREE user already over the reinstated ceiling (e.g. 3+ active Scouts) keeps what they have — Effective quota never force-pauses existing Scouts or removes existing Analyses — but is blocked from creating/reactivating further until they drop back under it. No grace period or advance notice was added beyond the existing 80%/100% QuotaAlert.
- A User already holding an explicit `QuotaOverride` from the unlimited-FREE period still takes precedence over this reinstated default, unchanged.
