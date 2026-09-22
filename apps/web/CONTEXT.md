# Web

The candidate-facing Next.js app and its BFF (backend-for-frontend) proxy layer — the only context a browser ever talks to. Holds no direct connection to Postgres, S3, or SQS; every data operation crosses to the [API](../../services/api/CONTEXT.md) context over HTTP.

## Language

**BFF route**:
A Next.js `app/api/*` route handler that validates the caller's session, forwards the request to the API context (internal secret + `userId`), and passes the response straight through — no business logic of its own.
_Avoid_: API route (ambiguous with the API context itself), proxy

**Session**:
The signed NextAuth JWT identifying the signed-in candidate, valid for 30 minutes. Carries the canonical `userId` resolved from the API context at sign-in; this context never reads or writes a `User` row directly.
_Avoid_: Auth token, cookie

**Magic link**:
The Email-provider sign-in flow — a one-time link sent to the candidate's inbox. Its verification token is minted and consumed via the API context's endpoints, never stored here.
_Avoid_: Verification email, passwordless login

**Side-by-side comparison**:
The view listing every Analysis requested for one JobOffer across different CVVersions, so a candidate can compare their fit CV-by-CV.
_Avoid_: Compare page (that's the route, this is what it shows)

**Batch result view**:
The single screen an "analyse several offers" request lands on: a progress header over both phases — offer discovery, then the analyses — above the Analysis batch shown as offers ranked by Match score, filling in as each Analysis completes.
_Avoid_: Results page (that's the route), ingestion job page — that's the scraping-progress view this links to, not this.

**Locale**:
The active UI language, `en` or `fr`. Resolved per request in `i18n/request.ts` — the `NEXT_LOCALE` cookie first, then the `Accept-Language` header, then `en`. There is no locale segment in the URL; `<html lang>` reflects it and the `LocaleSwitch` control changes it.
_Avoid_: Language (fine in prose, but the resolved value is the Locale), i18n (that's the mechanism)

**Landing page**:
The public `/` view a signed-out Visitor sees — a marketing page: hero with a "Sign in" call to action, a "how it works" walkthrough, a features grid, a product preview, an FAQ, and a footer. A signed-in Candidate hitting `/` is redirected to the Dashboard instead. Lives in `app/(public)`.
_Avoid_: Home (ambiguous with the Dashboard), marketing site (it's one in-app page, not a separate site)

**Dashboard**:
The signed-in overview at `/` — stat tiles (average and best Match score, analysis count, CV-version count), recent analyses, a Match-score trend, and quick actions. While the Candidate has no Analysis yet it shows a three-step onboarding checklist in place of the tiles. Where `/` sends a Candidate once they have a Session.
_Avoid_: Home, Overview (fine in prose; the term is Dashboard), analyses list (that's Analyses)

**Analyses**:
The list at `/analyses` — one row per Analysis (no SITE_SEARCH batch grouping; see [API](../../services/api/CONTEXT.md)'s Analysis batch, which this view deliberately no longer folds rows into), as a sortable, filterable table with Column visibility control: client-side search (title/company), a location search, a status filter (Tracking status plus `FAILED` — issue #172, see Tracking status below), a platform filter, and a `requestedAt` date-range filter, plus date/score/company/platform sort and multi-select bulk actions. Clicking a row opens its detail in a right-hand slide-over without leaving the list; the slide-over links out to the full Analysis detail page and the Side-by-side comparison for deeper reading. Reached from the Dashboard and the Sidebar.
_Avoid_: Dashboard (that's the overview now), analyses page (that's the route), History, batch view (retired from this list — a SITE_SEARCH batch's Analyses now just appear as their own rows, filterable/sortable like any other)

**Quick view**:
The right-hand slide-over opened by clicking an Analyses-list row (~1024px on desktop, full-width on mobile, over the list, no navigation) — the complete Analysis result breakdown in place (score gauge, matched and missing skills, strengths, weaknesses, improvement suggestions, summary — via the same `AnalysisResultView` the detail page renders), plus Tracking status and actions (view the offer, change Tracking status, generate documents, compare, and — on a `COMPLETED` or `FAILED` Analysis — Relancer l'analyse, which — for an `external` User — first asks which CVVersion to run it with, then switches the panel to the new Analysis it creates; see [API](../../services/api/CONTEXT.md)'s Re-run). Links out to the full Analysis detail page (for the Apply / Mark as applied action, which stays exclusive to it) and to the Side-by-side comparison.
_Avoid_: Detail page (that's the full `/analyses/[id]` route this links out to, still reachable on its own), Drawer/Sheet (the component underneath, not the product concept)

**Tracking status**:
The Analyses list's "Statut" column and filter — a candidate's pursuit state for one Analysis, folding the API context's `ApplicationStatus` (plus the common case of no Application existing yet, since it's created lazily) down to five buckets: **À postuler** (no Application row yet, or one still `DRAFT`), **En cours** (`APPLIED`, `INTERVIEWING`, or `OFFER`), **Refusé** (`REJECTED`), **Accepté** (`ACCEPTED`), **Retiré** (`WITHDRAWN`). Only meaningful for a `COMPLETED` Analysis; a still-running Analysis shows its pipeline state instead (raw `AnalysisStatus`) and stays excluded from every status filter bucket but "all". A `FAILED` Analysis likewise shows its own pipeline state, not a Tracking status — but, unlike every other non-`COMPLETED` status, it does get a filter bucket of its own (issue #172, `lib/tracking-status.ts`'s `ANALYSES_STATUS_FILTERS`): the Analyses list's (and Admin analyses table's) actual Statut filter is the 5 Tracking status buckets plus `FAILED`, not Tracking status alone.
_Avoid_: Status (ambiguous — pipeline `AnalysisStatus` or tracking `ApplicationStatus`?), Application status (that's the underlying 7-value enum this folds; not every value maps 1:1 — `DRAFT` folds into "À postuler")

**App shell**:
The persistent frame around every signed-in page: a left **Sidebar** (brand wordmark, the "New analysis" primary action, the Dashboard / Analyses / Agents / Applications / CV-versions / Settings links, and the user menu with theme, `LocaleSwitch`, sign out) plus a context **Topbar** (page title and page-level actions). Implemented as `app/(app)/layout.tsx` + `components/app-sidebar.tsx` + `components/app-topbar.tsx`; `app/(public)` pages render outside it. Collapses to a drawer on narrow viewports.
_Avoid_: Layout (too generic), navbar / header (it's a Sidebar now)

**Agents**:
The sidebar entry and `/scouts` area where a candidate creates and manages
Scouts (defined in [API](../../services/api/CONTEXT.md)'s context) — a
sortable, full-width table with Column visibility control (Label, Status,
Base CV, Sites, Last run, Relevant finds; Archived Scouts hidden by default
behind a "show archived" toggle, mirroring CV versions' superseded filter)
and a create/edit form.
Clicking a table row opens the Scout panel, which is the only place a
Scout's config, run history, patterns, and Finds are shown — there is no
separate detail page (docs/adr/0007).
_Avoid_: Scouts (fine in prose for the entity itself; "Agents" is
specifically the nav label and route area a candidate sees), Scout detail
page (retired — see Scout panel)

**Scout panel**:
The right-hand slide-over opened by clicking a Scouts-table row (~1152px on
desktop, full-width on mobile) — Configuration, Statistiques, Historique des
exécutions, Patterns, and Finds, plus Run now / Pause / Resume / Archive /
Edit. Absorbs everything the former `/scouts/[id]` detail page showed, that
route now being gone (docs/adr/0007, superseding docs/adr/0006's Quick-view
shape). Reachable directly via `/scouts?open=<id>`, which `/scouts` reads
once on mount to open the named Scout's panel before clearing the param —
the target of the Edit-Scout page's back-link, the create/edit form's
post-edit redirect, and an Application's "view Scout" back-link.
_Avoid_: Side bar / slide bar (same trap as the CV panel's entry above —
reads as the left-nav Sidebar or a mistranslation of "slide-over"), Quick
view (that's the Analyses-list one — lighter, and still links out to its own
full detail page, unlike this one)

**Applications**:
The sidebar entry and `/applications` area listing every Application
(defined in [API](../../services/api/CONTEXT.md)'s context) with filter and
sort by status, Scout, and date, a stats header (all-time / last-30-days),
and a detail page showing one Application's StatusEvent timeline and
back-links to its Analysis, Scout, and GeneratedDocuments.
_Avoid_: Tracker (fine in prose; the nav label and route area is
"Applications")

**CV versions**:
The `/cv-versions` page — a sortable table, with Column visibility control, of a candidate's CVVersions (defined in [API](../../services/api/CONTEXT.md)'s context): label, file name/type, size, upload date, Conversion status, and a default/superseded indicator. Clicking a row opens the CV panel. Reconvert and Set default act directly from a table row; uploading a new CV is its own `/cv-versions/new` route (reached via an "Importer un CV" action here), which returns to this table on success. Replacing supersedes the row rather than overwriting or deleting it (docs/adr/0005): the superseded CVVersion drops out of this table and out of the CvVersionPicker by default, reachable again only through an explicit "show superseded" filter — Reconvert stays available on a superseded row, but Set default and Replace do not.
_Avoid_: CV management, My CVs (fine in prose; the nav label and route area is "CV-versions")

**CV panel**:
The right-hand slide-over opened by clicking a CV-versions-table row: the CVVersion's Markdown rendition (fetched only while the panel is open, never inlined in the table) plus its full info, and its actions — Replace, Reconvert, Set default. A successful Replace switches the panel to the newly created CVVersion rather than closing it or lingering on the now-superseded row.
_Avoid_: Quick view (that's the Analyses-list slide-over — different content and actions; this is CV-versions' own), side bar / slide bar (a candidate's own phrasing that reads as the left-nav Sidebar or a mistranslation of "slide-over" — got issue #84 pointed at the wrong component once already; this is the CV panel)

**Column visibility**:
A per-table, per-browser preference (localStorage only, no server sync) for which data columns show in the Analyses, CV versions, and Agents tables — every column visible by default, each table's primary column always shown, selection/action columns excluded from the toggle. Long values in these tables (titles, company/location, CV/Scout labels, CV file names) are truncated to a fixed length with the full text in a tooltip on hover.
_Avoid_: Column settings, table preferences

**Quotas page**:
A dedicated page/tab showing a Candidate's own Effective quota and current usage (defined in [API](../../services/api/CONTEXT.md)'s context) for every QuotaKind as a progress bar — all four shown regardless of proximity to the limit, not just the ones near capacity. Where a QuotaAlert's persisted feed entries surface alongside the bars.
_Avoid_: Usage page, Dashboard (that's the overview; this is quota-specific), Plan defaults page (that's the Admin-area screen editing every Plan's PlanQuotaDefault — a different audience and content from this Candidate-facing screen)

**Admin area**:
The area reachable only by an Administrator (defined in [API](../../services/api/CONTEXT.md)'s context), gated by Role rather than Plan (docs/adr/0015, docs/adr/0017). Split across seven screens: the Admin dashboard, the Plan defaults page, the Admin users table plus User panel, the Admin analyses table, the Admin scouts table, the Admin CV versions table (docs/adr/0019), and the LLM providers table at `/admin/llm-providers` (docs/adr/0024; read-only until #175 — it lists the five providers, a "None — follow the environment" row naming the provider the API's environment resolves to, and each provider's Configuration status) — tied together by a shared tab strip in the area's layout and a sidebar nav entry, neither of which existed before the latter three screens were added.
_Avoid_: Admin panel (fine in prose), Dashboard (that's either the candidate overview or, in this area, specifically the Admin dashboard below)

**Admin dashboard**:
The `/admin` landing page — global aggregate stats (total Users, Users at/over a quota limit, Analyses/GeneratedDocuments volume, active Scouts), plus new-signups and Plan-distribution figures, filterable by a 7/30/90-day/all-time preset. That filter only narrows the time-series figures (signups, cumulative usage); snapshot figures (current totals, current Plan distribution) always reflect today regardless of it. Links out to the Plan defaults page and the Admin users table.
_Avoid_: Admin area (that's the whole gated section; this is just its landing screen), Dashboard (that's the candidate overview at `/`)

**Plan defaults page**:
The `/admin/quotas` page — PlanQuotaDefault values (defined in [API](../../services/api/CONTEXT.md)'s context) for `free`/`standard`/`premium` side by side, one column per Plan, one row per QuotaKind (`administrateur` no longer has a column — docs/adr/0015, docs/adr/0017). Each column's own Modifier button opens a slide-over form to edit that Plan's four values together; no Plan can be added or removed here.
_Avoid_: Quotas page (that's the Candidate-facing `/quotas` screen showing one User's own usage, not Plan configuration), Admin area (that's the whole section)

**Admin users table**:
The `/admin/users` table listing every User (defined in [API](../../services/api/CONTEXT.md)'s context) for an Administrator to search and manage — server-paginated, with search by name/email and filters for Plan (their Effective Plan), Role, Blocked status, and at/over quota limit. Row-level actions only, no multi-select: a quick Bloquer/Débloquer button per row (inline confirm, no modal), and clicking the row opens the User panel. Restyled after the Analyses table's conventions (Table/SortableHead primitives, URL-synced filter state).
_Avoid_: Users list, Admin area (that's the whole section), Analyses (a different table — only its styling is the reference here)

**User panel**:
The right-hand slide-over opened by clicking an Admin users table row — replaces the former dedicated `/admin/users/[id]` page entirely. Shows the User's info (name, editable; email, not editable from here), their Role (select, inline confirm), their quotas (QuotaOverride editing and assigning a new Subscription, defined in [API](../../services/api/CONTEXT.md)'s context), and an Audit history tab listing their AdminAuditEvents. Reachable directly via a `?user=<id>` query param on `/admin/users`, the same pattern the Scout panel's `?open=<id>` uses.
_Avoid_: Quick view, Scout panel, CV panel (different slide-overs, see their own entries), Historique (that's the Scout panel's own run-history tab; this one is Audit history)

**Admin analyses table**:
The `/admin/analyses` table listing every Analysis (defined in [API](../../services/api/CONTEXT.md)'s context) across every User — server-paginated, with a user picker (the same type-ahead the Admin users table's search backs), a status filter (the same 5 Tracking status buckets plus `FAILED` the candidate-facing Analyses list filters by — issue #172, reversing this table's earlier no-status-filter design once the candidate-facing page's own gap around `FAILED` made clear the vocabulary was worth sharing), and a date filter on `requestedAt`. Shows Tracking status as a read-only badge; no status-transition buttons — the status filter only narrows which rows list, same as every other filter here. Row-level actions only, no multi-select: Re-run ("Relancer l'analyse") and Generate documents ("Générer les documents"), docs/adr/0019, docs/adr/0020.
_Avoid_: Analyses (that's the Candidate-facing table at `/analyses` — different filters, no status-transition actions, and results of admin actions here stay owned by the Analysis's own candidate rather than the Administrator, docs/adr/0020)

**Admin scouts table**:
The `/admin/scouts` table listing every Scout (defined in [API](../../services/api/CONTEXT.md)'s context) across every User — server-paginated, with a user picker, a `lastRunAt` filter, and a status filter (`ACTIVE`/`PAUSED`/`ARCHIVED`). Row-level actions only: Run now, Pause/Resume (bidirectional), and Archive (one-way for an Administrator — no unarchive from here). No Edit, no Create.
_Avoid_: Agents (that's the Candidate-facing nav label for the same Scout entity, at `/scouts`, with its own broader action set including Edit and Create)

**Admin CV versions table**:
The `/admin/cv-versions` table listing every CVVersion (defined in [API](../../services/api/CONTEXT.md)'s context) across every User — server-paginated, with a user picker, a `createdAt` filter, and a status filter on `conversionStatus`. Superseded CVVersions are shown by default (no hide-toggle, unlike the Candidate-facing CV versions page) since this table exists to support auditing a candidate's full history. Row-level actions only: Reconvert. No Set default, Import, or Replace.
_Avoid_: CV versions (that's the Candidate-facing page at `/cv-versions`, which hides superseded rows by default and has the broader action set this table deliberately withholds)

**Settings**:
The `/settings` page — theme, Locale, and read-only account details (name and email from the Session), plus sign out. No account deletion (there is no API for it).
_Avoid_: Preferences, Account page
