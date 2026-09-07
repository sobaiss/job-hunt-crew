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
The list at `/analyses` — every standalone Analysis and every grouped SITE_SEARCH batch, with client-side search, status and CV filters, and date/score sort. Reached from the Dashboard and the Sidebar.
_Avoid_: Dashboard (that's the overview now), analyses page (that's the route), History

**App shell**:
The persistent frame around every signed-in page: a left **Sidebar** (brand wordmark, the "New analysis" primary action, the Dashboard / Analyses / CV-versions / Settings links, and the user menu with theme, `LocaleSwitch`, sign out) plus a context **Topbar** (page title and page-level actions). Implemented as `app/(app)/layout.tsx` + `components/app-sidebar.tsx` + `components/app-topbar.tsx`; `app/(public)` pages render outside it. Collapses to a drawer on narrow viewports.
_Avoid_: Layout (too generic), navbar / header (it's a Sidebar now)

**Settings**:
The `/settings` page — theme, Locale, and read-only account details (name and email from the Session), plus sign out. No account deletion (there is no API for it).
_Avoid_: Preferences, Account page
