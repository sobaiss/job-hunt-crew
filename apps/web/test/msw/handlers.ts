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
  // The Dashboard's "new matches from your agents" block (issue #56) reads
  // the Scout list; default to none so suites that don't care about Scouts
  // don't have to stub it.
  http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
  // The Scout detail page's relevant-finds / low-fit lists (issue #56);
  // default to empty so suites exercising other parts of the page (run
  // history, actions) don't have to stub it.
  http.get("/api/scouts/:id/finds", () =>
    HttpResponse.json({ relevantFinds: [], lowFitFinds: [] }),
  ),
  // The stats header (issue #60) on both the Applications view and a Scout's
  // detail page; default to all-zero so suites exercising other parts of
  // those pages don't have to stub it.
  http.get("/api/applications/stats", () => HttpResponse.json(ZERO_APPLICATION_STATS)),
  http.get("/api/scouts/:id/stats", () => HttpResponse.json(ZERO_APPLICATION_STATS)),
  // The "patterns across your matches" panel (issue #60); default to none.
  http.get("/api/scouts/:id/patterns", () => HttpResponse.json({ patterns: [] })),
];

const ZERO_APPLICATION_STATS_WINDOW = {
  offersDiscovered: 0,
  relevantFinds: 0,
  documentsGenerated: 0,
  applicationsSubmitted: 0,
  responseRate: 0,
  interviewRate: 0,
  offerRate: 0,
  acceptanceRate: 0,
  medianDaysToFirstResponse: null,
};

const ZERO_APPLICATION_STATS = {
  allTime: ZERO_APPLICATION_STATS_WINDOW,
  last30Days: ZERO_APPLICATION_STATS_WINDOW,
};
