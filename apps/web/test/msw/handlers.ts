import { http, HttpResponse } from "msw";

// The single MSW handler set: the only fake in Seam 1 (the HTTP boundary).
// Later tickets add the real BFF route handlers here; for now an example
// handler proves the wiring, plus a default NextAuth session endpoint so a
// bare `<SessionProvider>` (no `session` prop) doesn't hit the real network.
export const handlers = [
  http.get("/api/example", () => HttpResponse.json({ ok: true })),
  http.get("/api/auth/session", () => HttpResponse.json({})),
  // The Dashboard reads the site catalogue to name a grouped SITE_SEARCH batch
  // row (issue #34). Default to an empty catalogue so suites that don't care
  // about grouping don't have to stub it; grouping tests override with
  // `server.use`.
  http.get("/api/site-configs", () => HttpResponse.json({ siteConfigs: [] })),
];
