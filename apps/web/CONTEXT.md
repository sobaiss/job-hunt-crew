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
The list at `/analyses` — one row per Analysis (no SITE_SEARCH batch grouping; see [API](../../services/api/CONTEXT.md)'s Analysis batch, which this view deliberately no longer folds rows into), as a sortable, filterable table with Column visibility control: client-side search (title/company), a location search, a status filter (Tracking status plus the pipeline buckets `PENDING`/`FAILED` — see Tracking status below), a platform filter, and a `requestedAt` date-range filter, plus date/score/company/platform sort and multi-select bulk actions. Status and platform each take several values at once, as a checkbox menu: values inside one filter are OR-ed, the filters AND-ed, an empty selection means no filter, and the URL carries them comma-separated (`?status=TO_APPLY,FAILED`), which still reads a single-value link minted before that. The "Plus de filtres" toggle's count stays a count of *filters* — two platforms ticked count as one, since the number says how much is hiding inside the closed panel, not how many boxes are ticked. Clicking a row opens its detail in a right-hand slide-over without leaving the list; the slide-over links out to the full Analysis detail page and the Side-by-side comparison for deeper reading, and steps from one Analysis to the next itself (see Quick view navigation). Reached from the Dashboard and the Sidebar.
_Avoid_: Dashboard (that's the overview now), analyses page (that's the route), History, batch view (retired from this list — a SITE_SEARCH batch's Analyses now just appear as their own rows, filterable/sortable like any other)

**Quick view**:
The right-hand slide-over opened by clicking an Analyses-list row (~1024px on desktop, full-width on mobile, over the list) — the complete Analysis result breakdown in place (score gauge, matched and missing skills, strengths, weaknesses, improvement suggestions, summary — via the same `AnalysisResultView` the detail page renders), plus Tracking status and actions (view the offer, change Tracking status, generate either document, compare, and — on a `COMPLETED` or `FAILED` Analysis — Relancer l'analyse, which — for an `external` User — first asks which CVVersion to run it with, then switches the panel to the new Analysis it creates; see [API](../../services/api/CONTEXT.md)'s Re-run). On a `FAILED` Analysis it also shows that Analysis's own `errorMessage`, as the detail page does, so the relaunch it offers comes with a reason. A stuck Analysis gets its own block instead (see Interrupted analysis). Links out to the full Analysis detail page (for the Apply / Mark as applied action, which stays exclusive to it) and to the Side-by-side comparison. A sticky header carries its Quick view navigation and its Fermer.
_Avoid_: Detail page (that's the full `/analyses/[id]` route this links out to, still reachable on its own — the distinction from the Scout panel, which absorbed its own detail page outright under docs/adr/0007, is exactly that this one's page still exists; it is *not* that this panel is the lighter of the two, which stopped being true once it gained navigation and per-document generation), Drawer/Sheet (the component underneath, not the product concept)

**Quick view navigation**:
The Précédent / Suivant pair, and the "3 / 47" rank between them, in the Quick view's sticky header — and the ← / → keys, which do the same outside a form field. They step through the whole filtered, sorted Analyses list, not the visible page: reaching a rank on another page flips the table behind the panel to it. Disabled at each end rather than wrapping. An Analysis that leaves the active filter while its panel is open — the common case being a Tracking status changed from the panel itself while that status is being filtered on — keeps being shown, at rank "— / 47", and the arrows resume from the slot it left; taking it away would punish the action the candidate just took.
_Avoid_: Pagination (that's the table's own Précédent/Suivant under it, which moves 25 rows at a time and shares this one's labels — these two move one Analysis), Carousel

**Interrupted analysis**:
The alert block on the Analysis detail page and in the Quick view when the API reports an Analysis as stuck — "Cette analyse semble interrompue…" plus a Relancer l'analyse button. The condition is read straight off the API's `stuck` field, never re-derived from timestamps here, so the threshold stays one server-side setting and the endpoint's own re-check cannot disagree with the button that led to it (see [API](../../services/api/CONTEXT.md)'s Stuck). The Analyses-list bulk-actions bar carries the same repair over a selection, shown only when the selection holds at least one stuck row and labelled by how many ("Reprendre 2 analyses interrompues") — a restart strands rows by the dozen, and one Quick view at a time was the only route. It posts to `POST /api/analyses/{id}/requeue`, which re-drives the same Analysis and spends no quota — so the block deliberately does *not* carry the quota warning that Relancer l'analyse shows on a terminal Analysis. A `409` comes back as "Cette analyse est en fait toujours en cours de traitement", since the server re-checks and the row may have been picked up between the read and the click. While it shows, the "Cette analyse est toujours en cours" note is suppressed — both are true of a non-terminal row and together they contradict each other. The Analyses list does not poll on its own, so the block appears there after an Actualiser; the detail page polls and reveals it without being asked.
_Avoid_: Stuck analysis (fine in prose and it is the API's field name, but the user-facing term is "interrompue"), Failed analysis (a different block, with a different button and a quota cost), Stalled

**Tracking status**:
The Analyses list's "Statut" column and filter — a candidate's pursuit state for one Analysis, folding the API context's `ApplicationStatus` (plus the common case of no Application existing yet, since it's created lazily) down to five buckets: **À postuler** (no Application row yet, or one still `DRAFT`), **En cours** (`APPLIED`, `INTERVIEWING`, or `OFFER`), **Refusé** (`REJECTED`), **Accepté** (`ACCEPTED`), **Retiré** (`WITHDRAWN`). Only meaningful for a `COMPLETED` Analysis; a still-running Analysis shows its pipeline state instead (raw `AnalysisStatus`) and stays excluded from every status filter bucket but "all". Two of those pipeline statuses do get a filter bucket of their own, though (`lib/tracking-status.ts`'s `PIPELINE_ANALYSES_STATUS_FILTERS`, matched against `Analysis.status` rather than folded): **Échouée** (`FAILED`, issue #172) and **En attente** (`PENDING`) — the latter because it is where a Stuck analysis usually sits (a row whose queue message was lost never leaves `PENDING`, and a Requeue puts it back there; see [API](../../services/api/CONTEXT.md)'s entries), so this is the bucket that surfaces the rows worth repairing. So the Analyses list's (and Admin analyses table's) actual Statut filter is the 5 Tracking status buckets plus those two, not Tracking status alone; the other non-terminal statuses (`QUEUED`/`RUNNING_CREW`/`AWAITING_RESULT`/`PERSISTING`) still have no bucket and show only under "all". The two tables share those seven buckets but not the way they are picked: the Analyses list takes any number of them at once, the Admin analyses table still exactly one.
_Avoid_: Status (ambiguous — pipeline `AnalysisStatus` or tracking `ApplicationStatus`?), Application status (that's the underlying 7-value enum this folds; not every value maps 1:1 — `DRAFT` folds into "À postuler")

**App shell**:
The persistent frame around every signed-in page: a left **Sidebar** (brand wordmark, the "New analysis" primary action, the Dashboard / Analyses / Agents / Applications / CV-versions / Settings links, and the user menu with theme, `LocaleSwitch`, sign out) plus a context **Topbar** (page title and page-level actions). What the Sidebar lists depends on the Role: an Administrator gets the Admin area's seven screens under an "Administration" heading, then Settings below a rule, in place of the per-Candidate rows — the Topbar's title comes from those same rows, so it names the Admin section being viewed. Implemented as `app/(app)/layout.tsx` + `components/app-sidebar.tsx` + `components/app-topbar.tsx`; `app/(public)` pages render outside it. Collapses to a drawer on narrow viewports, and to an icon-only rail on desktop (where the group heading goes with the labels and the rule alone separates the groups).
_Avoid_: Layout (too generic), navbar / header (it's a Sidebar now)

**Agents**:
The sidebar entry and `/scouts` area where a candidate creates and manages
Scouts (defined in [API](../../services/api/CONTEXT.md)'s context) — a
sortable, full-width table with Column visibility control (Label, Status,
Execution column, Base CV, Sites, Last run, Relevant finds; Archived Scouts
hidden by default behind a "show archived" toggle, mirroring CV versions'
superseded filter)
and a create/edit form.
Clicking a table row opens the Scout panel, which is the only place a
Scout's config, run history, and Finds are shown — there is no separate
detail page (docs/adr/0007).
_Avoid_: Scouts (fine in prose for the entity itself; "Agents" is
specifically the nav label and route area a candidate sees), Scout detail
page (retired — see Scout panel)

**Execution column**:
The Scouts table's "Exécution" column — one badge per row carrying the API's
Run state (see [API](../../services/api/CONTEXT.md)): **En cours** with how
long it has been working, **Bloqué**, **Échec**, **Dégradé**, **À jour** as
muted text rather than a coloured badge, and a plain `—` when the Scout has
never run, since "Jamais exécuté" is already the adjacent Last-run column's
answer. It sits immediately after Status, and the two are meant to be read
together: lifecycle beside activity, so a paused Scout whose last run failed
tells its whole story without a click. Never re-derives the state from
timestamps here — the condition is read straight off `runState`, the
duration computed from `runStateSince` at minute granularity on each poll
(no ticking timer; the work lasts minutes, and scrolling seconds would be
agitation, not information). Sorting uses an explicit severity rank — worst
first: Bloqué, Échec, Dégradé, En cours, À jour, jamais exécuté — which is
**not** the precedence order the API applies when several states hold at
once; conflating the two would bury what the column exists to surface.
Each badge carries a `Tooltip` with the full sentence and the remedy, the
same primitive `TruncatedCell` already uses in this table: with three
abnormal states and only one of them repairable by the candidate,
explaining *is* the feature for the other two.
_Avoid_: Status column (that is the `ACTIVE`/`PAUSED`/`ARCHIVED` one beside
it — the whole point is that they are two columns), Health column, Progress
column (no fraction is shown; see Scout panel for why)

**Blocked-analyses repair**:
The Scout panel's "Relancer les N analyses bloquées" action, shown in the
panel header only while the Scout's Run state is `BLOCKED`. Fans the
existing per-Analysis Requeue over `blockedAnalysisIds` via
`useBulkRequeueAnalyses` — the same hook the Analyses-list bulk bar uses for
Interrupted analysis — so no new endpoint, and no quota spent. It exists for
exactly one of the three red states: a stale run closes itself at the next
guard and a run that failed on a disabled site needs an Administrator, so
for those two the panel explains and offers nothing (docs/adr/0033).
_Avoid_: Relancer le Scout / Run again (that is "Lancer maintenant", which
the one-hour cooldown may still be refusing), Reprendre (the Analyses list's
own wording for the same repair over its own selection)

**Run cooldown**:
What "Lancer maintenant" reads while the API would refuse it — "Disponible
dans 47 min", counted from the latest run's `createdAt`, the same clock
`POST /v1/scouts/{id}/run` rate-limits on. The button therefore has three
faces, not two: **En cours…** while the Run state is `IN_FLIGHT`, then the
countdown until the hour is up, then itself. Before this, the button was
disabled only for the few hundred milliseconds the `POST` took, so a
candidate learned about the cooldown by clicking and reading a red 429 —
which is the surplus click the whole Execution column exists to prevent. The
`scouts.runs.rateLimited` message stays as the backstop for a stale screen,
not as the way the rule is discovered.
_Avoid_: Rate limit (the server's term for the same rule — fine in prose and
in the API context, but the candidate-facing concept is the countdown),
Throttle, Debounce

**Scout panel**:
The right-hand slide-over opened by clicking a Scouts-table row (~1152px on
desktop, full-width on mobile): a sticky header carrying the label, status,
and every action (Run now / Pause / Resume / Edit / Archive), then
Configuration paired with Statistiques, then Résultats pertinents, then
Historique des exécutions — each a `PanelSection`. The header also carries
the Run state badge and its duration beside the lifecycle status, and the
Blocked-analyses repair when there is one; it deliberately shows **no**
progress fraction, because `offersAnalysed / offersDiscovered` belongs to
one run while the badge is scoped to the Scout, so the two could visibly
disagree — the live per-run counters stay in Historique des exécutions,
which already polls them (docs/adr/0033). Absorbs everything the
former `/scouts/[id]` detail page showed, that route now being gone
(docs/adr/0007, superseding docs/adr/0006's Quick-view shape), minus the
"Patterns across your matches" panel and the "found — low fit" list, both
since dropped. Reachable directly via `/scouts?open=<id>`, which `/scouts`
reads once on mount to open the named Scout's panel before clearing the
param — the target of the Edit-Scout page's back-link, the create/edit
form's post-edit redirect, and an Application's "view Scout" back-link.
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

**Import**:
The single candidate-facing act of adding a CV: choosing a file **and** getting back a readable CV. It is deliberately not finished when the bytes are stored — an Import has only succeeded once that CVVersion's Markdown rendition exists (defined in [API](../../services/api/CONTEXT.md)'s context), which is why the candidate never has to ask for the Conversion separately and never sees a freshly imported CV sitting at "En attente". The Import screen is where the whole act plays out and where its outcome is shown; a Conversion that fails is an Import that failed at its second half, not a successful upload with a pending chore attached.
_Avoid_: Upload / Téléversement (that is only the first half — naming the whole act after it is exactly what made the old flow read as "nothing happened"), Conversion (the [Analysis](../../services/analysis/CONTEXT.md)-context step an Import triggers, not the act itself), Add a CV

**Import screen**:
The `/cv-versions/new` page, reached via "Importer un CV" from the CV versions page — the whole Import in one route, without navigating away: a form (file first, label pre-filled from the file name), then a step-by-step progress state while the file uploads and the Conversion runs, then either the imported CV rendered as HTML in the same frame the progress skeleton occupied, or a failure. The two failures are kept apart because their recovery differs: an upload that failed offers to retry the upload and discards its half-created CVVersion if the candidate leaves; a Conversion that failed keeps the CVVersion (the file is stored and valid) and offers to retry the Conversion or replace the file. A Close action is present in every state and returns to the CV versions table. The screen carries the CVVersion's id in its URL from the moment the row exists, so a reload resumes the same Import rather than losing track of a CV that is already being converted. A Conversion that is still running after three minutes stops being followed: the screen says it continues in the background and will be in the CV versions table, and offers to keep waiting — a tab polling forever against a stopped worker is worse than saying so.
_Avoid_: Upload page / Upload form (see Import), New CV page (fine in prose; the act it performs is the Import)

**CV versions**:
The `/cv-versions` page — a sortable table, with Column visibility control, of a candidate's CVVersions (defined in [API](../../services/api/CONTEXT.md)'s context): label, file name/type, size, upload date, Conversion status, and a default/superseded indicator. Clicking a row opens the CV panel. Reconvert and Set default act directly from a table row; adding a CV is the Import, on its own `/cv-versions/new` route (reached via an "Importer un CV" action here), which shows the imported CV in place rather than returning here — this table is reached again only by the Import screen's Close action. The table does not refresh itself: when a row is still converting, a banner at the top says so and offers the same Refresh action the header already carries, rather than polling on the candidate's behalf. Replacing supersedes the row rather than overwriting or deleting it (docs/adr/0005): the superseded CVVersion drops out of this table and out of the CvVersionPicker by default, reachable again only through an explicit "show superseded" filter — Reconvert stays available on a superseded row, but Set default and Replace do not. Deleting (from the CV panel, docs/adr/0027) removes a whole CV (defined in API's context) — the current row plus every version it superseded — and is only offered from the current row, not a superseded one.
_Avoid_: CV management, My CVs (fine in prose; the nav label and route area is "CV-versions")

**CV panel**:
The right-hand slide-over opened by clicking a CV-versions-table row: the CVVersion's Markdown rendition (fetched only while the panel is open, never inlined in the table) plus its full info, and its actions — Replace, Reconvert, Set default, Delete, and, on a converted non-superseded row, Modifier (links out to the CV edit page). A successful Replace switches the panel to the newly created CVVersion rather than closing it or lingering on the now-superseded row, and — unlike the Import screen, which walks the candidate through the same wait — it reports nothing about the Conversion it just started beyond the new row's status. That asymmetry is known and deliberate for now: Replace here is a quick action on a CV the candidate already has, not the guided first encounter an Import is. Delete (like Replace and Modifier) is only offered on a non-superseded row, asks for inline confirmation naming how many earlier versions will go with it, and closes the panel on success (docs/adr/0027) — services/api is the only place eligibility is actually checked (a version used in an Analysis, IngestionJob, Scout, Application, or GeneratedDocument rejects it with a 409), so this panel doesn't try to predict that client-side.
_Avoid_: Quick view (that's the Analyses-list slide-over — different content and actions; this is CV-versions' own), side bar / slide bar (a candidate's own phrasing that reads as the left-nav Sidebar or a mistranslation of "slide-over" — got issue #84 pointed at the wrong component once already; this is the CV panel)

**CV edit page**:
The `/cv-versions/[id]/edit` page, reached only via the CV panel's Modifier action on a CVVersion that is not superseded and already has a converted Markdown rendition. Shows that rendition rendered as HTML by default, in a bordered white frame; a Modifier toggle switches to a plain-text editor of the raw Markdown with Enregistrer/Annuler. Enregistrer asks for confirmation, then mutates the CVVersion's Markdown rendition in place rather than creating a new CVVersion (docs/adr/0025) — the one candidate-facing CV action that isn't Replace-shaped.
_Avoid_: CV panel (that's the slide-over this links from, and where Reconvert/Replace/Set default still live), Edit (fine in prose for the action itself, this is the page it opens)

**Column visibility**:
A per-table, per-browser preference (localStorage only, no server sync) for which data columns show in the Analyses, CV versions, and Agents tables — every column visible by default, each table's primary column always shown, selection/action columns excluded from the toggle. Long values in these tables (titles, company/location, CV/Scout labels, CV file names) are truncated to a fixed length with the full text in a tooltip on hover.
_Avoid_: Column settings, table preferences

**Quotas page**:
A dedicated page/tab showing a Candidate's own Effective quota and current usage (defined in [API](../../services/api/CONTEXT.md)'s context) for every QuotaKind as a progress bar — all four shown regardless of proximity to the limit, not just the ones near capacity. Where a QuotaAlert's persisted feed entries surface alongside the bars.
_Avoid_: Usage page, Dashboard (that's the overview; this is quota-specific), Plan defaults page (that's the Admin-area screen editing every Plan's PlanQuotaDefault — a different audience and content from this Candidate-facing screen)

**Admin area**:
The area reachable only by an Administrator (defined in [API](../../services/api/CONTEXT.md)'s context), gated by Role rather than Plan (docs/adr/0015, docs/adr/0017). Split across seven screens: the Admin dashboard, the Plan defaults page, the Admin users table plus User panel, the Admin analyses table, the Admin scouts table, the Admin CV versions table (docs/adr/0019), and the LLM providers table at `/admin/llm-providers` (docs/adr/0024; read-only until #175 — it lists the five providers, a "None — follow the environment" row naming the provider the API's environment resolves to, and each provider's Configuration status) — tied together by the App shell's Sidebar, which lists all seven under an "Administration" heading for an Administrator and is the area's only menu: the area's layout is the Role gate and nothing else, having briefly also carried a tab strip of its own over each screen.
_Avoid_: Admin panel (fine in prose), Dashboard (that's either the candidate overview or, in this area, specifically the Admin dashboard below)

**Admin dashboard**:
The `/admin` landing page — a row of headline figures (total Users, Analyses today with the month's total under it, active Scouts, GeneratedDocuments today), then new signups as a time series beside the Plan distribution as share bars and a "Needs attention" pair (Users at/over a quota limit, blocked Users). The 7/30/90-day/all-time preset lives in the signups panel because signups are the only figure it narrows; every other figure reflects today regardless of it. Each figure with a section behind it is a link into that section (Users, Analyses, Scouts, the Plan defaults page), which is the only navigation it carries — moving between Admin screens is the Sidebar's job.
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
The `/admin/analyses` table listing every Analysis (defined in [API](../../services/api/CONTEXT.md)'s context) across every User — server-paginated, with a user picker (the same type-ahead the Admin users table's search backs), a status filter (the same 5 Tracking status buckets plus the pipeline `PENDING`/`FAILED` the candidate-facing Analyses list filters by — issue #172, reversing this table's earlier no-status-filter design once the candidate-facing page's own gap around `FAILED` made clear the vocabulary was worth sharing; one bucket at a time here, where the candidate-facing list now takes several — this one's filter is applied server-side, and what the two share is the vocabulary, not the interaction), and a date filter on `requestedAt`. Shows Tracking status as a read-only badge; no status-transition buttons — the status filter only narrows which rows list, same as every other filter here. Row-level actions only, no multi-select: Re-run ("Relancer l'analyse") and Generate documents ("Générer les documents"), docs/adr/0019, docs/adr/0020.
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
