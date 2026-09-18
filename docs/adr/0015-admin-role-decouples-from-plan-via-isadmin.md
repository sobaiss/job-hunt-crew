# Admin role decouples from Plan via `isAdmin`

`User.plan` used to conflate usage tier and admin access: `administrateur` meant unlimited quotas *and* was the only way to reach the Admin area — a deliberate simplification on the assumption that administering the system and running one's own job search as a Candidate would never need to be true for the same User at once. The admin/users redesign breaks that assumption directly: an Administrator now edits their own info and role from the same User panel a Candidate's row uses, and there's no reason an Administrator shouldn't also keep a real quota tier.

We added a separate `User.isAdmin` boolean and moved every admin gate (`admin/layout.tsx`, `require_admin`) onto it instead of `plan === administrateur`. Existing `administrateur` Users were migrated to `plan = premium, isAdmin = true`. The Postgres `Plan` enum keeps the `administrateur` value rather than dropping it via `ALTER TYPE ... DROP VALUE` — a live drop is riskier than leaving one unused value behind — so it's now vestigial: still valid, never assigned again.

Consequence: the Plan defaults page (and PlanQuotaDefault generally) only has three columns that matter — `free`/`standard`/`premium` — `administrateur`'s row stays in the table but is never surfaced.
