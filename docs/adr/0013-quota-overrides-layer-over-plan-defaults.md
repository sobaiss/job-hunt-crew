# Quota overrides layer over Plan defaults, not per-user copies

When we added per-user quota management, we chose to store only explicit `QuotaOverride` rows per (User, QuotaKind), rather than materializing all four quota values into every User row at signup. A User with no override simply tracks their Plan's `PlanQuotaDefault` live, including after it changes.

We considered materializing a full quota row per user at creation time, copied from their Plan's defaults at that moment. It's simpler to reason about per-row, but it means raising a Plan's default (e.g., "standard" analyses/day going from 50 to 60) requires a bulk backfill across every User on that Plan, and loses the distinction between "never customized" and "customized to today's default value." The override-overlay model makes a Plan-wide change instant for everyone except the Users an Administrator has explicitly pinned.
