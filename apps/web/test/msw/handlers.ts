import { http, HttpResponse } from "msw";

// The single MSW handler set: the only fake in Seam 1 (the HTTP boundary).
// Later tickets add the real BFF route handlers here; for now an example
// handler proves the wiring, plus a default NextAuth session endpoint so a
// bare `<SessionProvider>` (no `session` prop) doesn't hit the real network.
export const handlers = [
  http.get("/api/example", () => HttpResponse.json({ ok: true })),
  http.get("/api/auth/session", () => HttpResponse.json({})),
  // The Admin area landing page (issue #138); default to an administrateur
  // response since only that Plan ever reaches the page's own layout gate.
  // Suites exercising the 403/401 path override with `server.use`.
  http.get("/api/admin/me", () =>
    HttpResponse.json({ userId: "admin-1", plan: "ADMINISTRATEUR" }),
  ),
  // The Dashboard reads the site catalogue to name a grouped SITE_SEARCH batch
  // row (issue #34). Default to an empty catalogue so suites that don't care
  // about grouping don't have to stub it; grouping tests override with
  // `server.use`.
  http.get("/api/site-configs", () => HttpResponse.json({ siteConfigs: [] })),
  // The Dashboard's "new matches from your agents" block (issue #56) reads
  // the Scout list; default to none so suites that don't care about Scouts
  // don't have to stub it.
  http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
  // The Scout panel's relevant-finds / low-fit lists (issue #56); default to
  // empty so suites exercising other parts of the panel (run history,
  // actions) don't have to stub it.
  http.get("/api/scouts/:id/finds", () =>
    HttpResponse.json({ relevantFinds: [], lowFitFinds: [] }),
  ),
  // The stats header (issue #60) on both the Applications view and the Scout
  // panel; default to all-zero so suites exercising other parts of those
  // pages don't have to stub it.
  http.get("/api/applications/stats", () => HttpResponse.json(ZERO_APPLICATION_STATS)),
  http.get("/api/scouts/:id/stats", () => HttpResponse.json(ZERO_APPLICATION_STATS)),
  // The "patterns across your matches" panel (issue #60); default to none.
  http.get("/api/scouts/:id/patterns", () =>
    HttpResponse.json({ patterns: [], weaknesses: [] }),
  ),
  // The Scout panel's run history (issue #92, folded in from the former
  // `/scouts/[id]` detail page); default to none so suites exercising other
  // parts of the panel don't have to stub it.
  http.get("/api/scouts/:id/runs", () => HttpResponse.json({ scoutRuns: [] })),
  // The Analysis detail page's GeneratedDocumentsPanel and "Apply" action
  // (issue #59) check for already-generated documents on load; default to
  // none so suites exercising other parts of the page don't have to stub it.
  http.get("/api/analyses/:id/generated-documents", () =>
    HttpResponse.json({ generatedDocuments: [] }),
  ),
  // The Effective quota + usage for all four QuotaKinds (issue #141) — read
  // unconditionally by the Analyses table's bulk "Générer les documents" and
  // "Relancer l'analyse" actions, and by the Quotas page and the "Analyse
  // several offers" pre-submit estimate; default to a generous budget on
  // every kind so suites exercising unrelated parts of those pages don't
  // have to stub it. Quota-threshold tests override with `server.use`.
  http.get("/api/quotas", () =>
    HttpResponse.json({
      activeScouts: { cap: 20, used: 0, remaining: 20 },
      analysesDaily: { cap: 20, used: 0, remaining: 20 },
      analysesMonthly: { cap: 200, used: 0, remaining: 200 },
      documentsDaily: { cap: 20, used: 0, remaining: 20 },
      alerts: [],
    }),
  ),
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
