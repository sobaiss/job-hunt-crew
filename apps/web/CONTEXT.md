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

**Locale**:
The active UI language, `en` or `fr`. Resolved per request in `i18n/request.ts` — the `NEXT_LOCALE` cookie first, then the `Accept-Language` header, then `en`. There is no locale segment in the URL; `<html lang>` reflects it and the `LocaleSwitch` control changes it.
_Avoid_: Language (fine in prose, but the resolved value is the Locale), i18n (that's the mechanism)

**Landing page**:
The public `/` view a signed-out Visitor sees — the product statement and a "Sign in" call to action. A signed-in Candidate hitting `/` is redirected to the Dashboard instead. Lives in `app/(public)`.
_Avoid_: Home (ambiguous with the Dashboard)

**Dashboard**:
The signed-in landing view — the analyses list at `/analyses`. Where `/` sends a Candidate once they have a Session.
_Avoid_: Home, analyses page (that's the route)

**App shell**:
The persistent frame around every signed-in page: the header with the brand, primary navigation, and the user menu (theme control, `LocaleSwitch`, sign out). Implemented as `app/(app)/layout.tsx` + `components/app-header.tsx`; `app/(public)` pages render outside it.
_Avoid_: Layout (too generic), navbar (it's more than the nav)
