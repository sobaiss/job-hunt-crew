# Plan-scoped quotas replace the global env-var caps

Active-Scout count, daily Analysis count, and daily GeneratedDocument count were each capped by a global environment variable applied identically to every User: `MAX_SCOUTS_PER_USER`, `DAILY_ANALYSIS_CAP`, `DAILY_GENERATION_CAP` (the latter two in `packages/py-db/src/py_db/quota.py`). We're replacing all three outright with Plan-scoped `PlanQuotaDefault`s plus per-User `QuotaOverride`s — no env var is kept as a fallback ceiling.

The three env vars are removed rather than layered underneath the new system, so there's a single source of truth for every limit rather than two competing ones. The existing enforcement call sites stay the same — `services/api`'s `POST /v1/analyses` and the `services/ingestion` fan-out both independently re-check the Analysis cap today, and both now read the same shared quota-resolution logic in `py_db` instead of the same env var.
