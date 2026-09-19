# Admin-wide Analyses, Scouts, and CV Versions ship as dedicated admin screens, not conditional views

Giving an Administrator a cross-user view of Analyses, Scouts, and CV Versions could have been built by branching the existing candidate pages (`/analyses`, `/scouts`, `/cv-versions`) on `role === ADMINISTRATOR`, reusing their client-side fetch-all-then-filter approach. We rejected that: those pages assume one candidate's data set fits unpaginated in a single response, which stops being true across every candidate at once, and the two roles' action sets differ enough (admin has no bulk actions, no status-transition buttons, no create/edit) that branching the same components would sprawl into role conditionals throughout otherwise candidate-only code.

We instead extend the Admin area (docs/adr/0015, docs/adr/0017) with three new screens — `/admin/analyses`, `/admin/scouts`, `/admin/cv-versions` — backed by new `require_admin`-gated `/v1/admin/*` list endpoints that filter/sort/paginate server-side, the same shape `GET /v1/admin/users` already established. A shared tab strip in `admin/layout.tsx` and one sidebar nav entry (the Admin area previously had neither) tie the resulting six screens together.

## Consequences

- Candidate-facing list components stay free of admin-only branches.
- The admin list endpoints duplicate some per-entity filtering logic that already exists for candidates, rather than sharing one parameterized endpoint across both roles.
