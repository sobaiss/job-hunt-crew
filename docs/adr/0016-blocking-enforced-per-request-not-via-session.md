# Blocking a User is enforced per-request, not via session revocation

Sessions are stateless 30-minute JWTs (`apps/web/auth.ts`), chosen specifically because "JWT sessions can't be revoked server-side on demand." Blocking a User — denying further access, reversible, no suspension of their Scouts or data — can't take effect by touching NextAuth at all: an already-issued JWT stays valid regardless of what changes in Postgres.

We enforce it in `services/api` instead: every request checks the caller's `blockedAt`, the same way `require_admin` already checks `isAdmin`. A block takes effect immediately, even against an already-active session, independent of the JWT's remaining lifetime. On the first rejected call, Web signs the Candidate out and shows a dedicated "blocked" page rather than surfacing a generic per-request error.
