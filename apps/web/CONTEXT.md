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
The list at `/analyses` — one row per Analysis (no SITE_SEARCH batch grouping; see [API](../../services/api/CONTEXT.md)'s Analysis batch, which this view deliberately no longer folds rows into), as a sortable, filterable table: client-side search, Tracking status filter, and date/score/company/platform sort, plus multi-select bulk actions. Clicking a row opens its detail in a right-hand slide-over without leaving the list; the slide-over links out to the full Analysis detail page and the Side-by-side comparison for deeper reading. Reached from the Dashboard and the Sidebar.
_Avoid_: Dashboard (that's the overview now), analyses page (that's the route), History, batch view (retired from this list — a SITE_SEARCH batch's Analyses now just appear as their own rows, filterable/sortable like any other)

**Quick view**:
The right-hand slide-over opened by clicking an Analyses-list row (~1024px on desktop, full-width on mobile, over the list, no navigation) — the complete Analysis result breakdown in place (score gauge, matched and missing skills, strengths, weaknesses, improvement suggestions, summary — via the same `AnalysisResultView` the detail page renders), plus Tracking status and actions (view the offer, change Tracking status, generate documents, compare). Links out to the full Analysis detail page (for the Apply / Mark as applied action, which stays exclusive to it) and to the Side-by-side comparison.
_Avoid_: Detail page (that's the full `/analyses/[id]` route this links out to, still reachable on its own), Drawer/Sheet (the component underneath, not the product concept)

**Tracking status**:
The Analyses list's "Statut" column and filter — a candidate's pursuit state for one Analysis, folding the API context's `ApplicationStatus` (plus the common case of no Application existing yet, since it's created lazily) down to five buckets: **À postuler** (no Application row yet, or one still `DRAFT`), **En cours** (`APPLIED`, `INTERVIEWING`, or `OFFER`), **Refusé** (`REJECTED`), **Accepté** (`ACCEPTED`), **Retiré** (`WITHDRAWN`). Only meaningful for a `COMPLETED` Analysis; a still-running or `FAILED` Analysis shows its pipeline state instead (raw `AnalysisStatus`) and is excluded from every Tracking status filter bucket.
_Avoid_: Status (ambiguous — pipeline `AnalysisStatus` or tracking `ApplicationStatus`?), Application status (that's the underlying 7-value enum this folds; not every value maps 1:1 — `DRAFT` folds into "À postuler")

**App shell**:
The persistent frame around every signed-in page: a left **Sidebar** (brand wordmark, the "New analysis" primary action, the Dashboard / Analyses / Agents / Applications / CV-versions / Settings links, and the user menu with theme, `LocaleSwitch`, sign out) plus a context **Topbar** (page title and page-level actions). Implemented as `app/(app)/layout.tsx` + `components/app-sidebar.tsx` + `components/app-topbar.tsx`; `app/(public)` pages render outside it. Collapses to a drawer on narrow viewports.
_Avoid_: Layout (too generic), navbar / header (it's a Sidebar now)

**Agents**:
The sidebar entry and `/scouts` area where a candidate creates and manages
Scouts (defined in [API](../../services/api/CONTEXT.md)'s context) — list,
create/edit form, and a detail page showing config, run history, relevant
finds, the patterns panel, and per-Scout stats.
_Avoid_: Scouts (fine in prose for the entity itself; "Agents" is
specifically the nav label and route area a candidate sees)

**Applications**:
The sidebar entry and `/applications` area listing every Application
(defined in [API](../../services/api/CONTEXT.md)'s context) with filter and
sort by status, Scout, and date, a stats header (all-time / last-30-days),
and a detail page showing one Application's StatusEvent timeline and
back-links to its Analysis, Scout, and GeneratedDocuments.
_Avoid_: Tracker (fine in prose; the nav label and route area is
"Applications")

**CV versions**:
The `/cv-versions` page — list a candidate's CVVersions (defined in [API](../../services/api/CONTEXT.md)'s context) with their Conversion status, upload a new one, set the default, and Replace an existing one with a new file. Replacing supersedes the row rather than overwriting or deleting it (docs/adr/0005): the superseded CVVersion drops out of this list and out of the CvVersionPicker by default, reachable again only through an explicit "show superseded" filter.
_Avoid_: CV management, My CVs (fine in prose; the nav label and route area is "CV-versions")

**Settings**:
The `/settings` page — theme, Locale, and read-only account details (name and email from the Session), plus sign out. No account deletion (there is no API for it).
_Avoid_: Preferences, Account page
