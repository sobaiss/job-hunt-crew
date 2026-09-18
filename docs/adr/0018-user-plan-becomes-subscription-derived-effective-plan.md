# A User's Plan becomes a Subscription; Effective Plan is always derived, never cached

`User.plan` was a single static value — no notion of when it started, whether it expires, or what a User held before. Modeling real subscription terms (a Plan held for a month or a year, renewable) needs a period, and a period needs its own row: we added `Subscription` (`userId`, `plan`, `startDate`, `endDate`, `duration`), append-only — assigning or renewing a Plan always inserts a new Subscription rather than editing one in place, so the full history of what a User held and when survives.

We considered keeping `User.plan` as a denormalized cache kept in sync whenever a Subscription changes, which would have left every existing PlanQuotaDefault/QuotaOverride call site untouched. We chose to drop it instead: a cached field is only as current as whatever writes it, and nothing writes it when a Subscription simply lapses — an Administrator has to act first for the cache to move. Deriving Effective Plan live from Subscription on every read means a User's access is never stale relative to their actual Subscription state, at the cost of a join everywhere a Plan is read.

That same reasoning ruled out a scheduled job that would close a lapsed Subscription and insert a fresh `free` one at expiry (the shape `services/scout`'s scheduler already establishes for daily Scout runs) — it would only move the staleness window from "however long since the cache last wrote" to "however long since the job's last tick," not remove it. We accepted the alternative cost instead: a User's Subscription history can show a gap (no row) between a lapsed Subscription and whatever comes next, which reads as `free` for that stretch without a row saying so explicitly.

Existing Users were each migrated one Subscription, matching their `plan` value at migration time: `free` Users got an unbounded `free` Subscription starting at the migration date; `standard`/`premium` Users got a `yearly` Subscription starting at the migration date, so nobody already paying is silently downgraded or left to expire the moment this ships.

## Considered options
- Keep `User.plan` as a cache — rejected: stale on natural expiry, since nothing external writes it when time simply passes with no admin action.
- A scheduled expiry job (reusing the Scout scheduler's pattern) that closes lapsed Subscriptions and inserts a `free` one — rejected: moves the staleness window instead of closing it, and is new operational surface for a guarantee (`free` is the floor) that already holds by construction once Effective Plan is derived correctly.

## Consequences
- Every quota read site (PlanQuotaDefault/QuotaOverride resolution) now queries Subscription instead of reading a column — see Effective Plan.
- A User's Subscription history has no row for time spent on the implicit `free` floor after a lapse — only for `free` periods explicitly assigned (e.g. at signup, or by an Administrator).
