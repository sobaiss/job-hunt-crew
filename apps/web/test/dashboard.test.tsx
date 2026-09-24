import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { Dashboard } from "@/components/dashboard";
import type { AnalysesStats } from "@/hooks/use-analyses";

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv1",
    ingestionJobId: null,
    ingestionJob: null,
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme Inc",
      location: "Paris",
    },
    cvVersion: { label: "Grad CV" },
    resultJSON: null,
    errorMessage: null,
    ...overrides,
  };
}

/** The Dashboard's numbers come from `/api/analyses/stats`, over every
 *  Analysis the candidate has, rather than from a list it counts itself
 *  (docs/adr/0033) — so a test says what the endpoint answers rather than
 *  handing over rows for the browser to add up. `recent` is the separate,
 *  short list behind the "Recent analyses" card. */
const NO_STATS: AnalysesStats = {
  analysisCount: 0,
  averageScore: null,
  bestScore: null,
  bestScoreOffer: null,
  analysesThisWeek: 0,
  hasComparison: false,
  trend: [],
};

function stub(options: {
  stats?: Partial<AnalysesStats>;
  recent?: unknown[];
  statsStatus?: number;
  cvVersions?: unknown[];
  scouts?: unknown[];
}) {
  server.use(
    http.get("/api/analyses/stats", () =>
      options.statsStatus
        ? HttpResponse.json({ error: "boom" }, { status: options.statsStatus })
        : HttpResponse.json({ ...NO_STATS, ...options.stats }),
    ),
    http.get("/api/analyses", () => {
      const analyses = options.recent ?? [];
      return HttpResponse.json({
        analyses,
        total: analyses.length,
        page: 1,
        pageSize: analyses.length,
      });
    }),
    http.get("/api/cv-versions", () =>
      HttpResponse.json({ cvVersions: options.cvVersions ?? [] }),
    ),
    http.get("/api/scouts", () =>
      HttpResponse.json({ scouts: options.scouts ?? [] }),
    ),
  );
}

function cv(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv1",
    supersededById: null,
    ...overrides,
  };
}

describe("Dashboard", () => {
  it("shows a loading state while the data is in flight", () => {
    stub({ cvVersions: [] });
    renderWithProviders(<Dashboard />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows the onboarding checklist instead of stat tiles when there are no analyses", async () => {
    stub({ cvVersions: [cv({ id: "cv1" })] });

    renderWithProviders(<Dashboard />);

    expect(
      await screen.findByText("Get started in three steps"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Average match score")).not.toBeInTheDocument();

    // Step 1 (has a CV) is done; step 2 (an analysis) is not.
    const importStep = screen.getByText("Import a CV", { selector: "span" });
    expect(importStep).toHaveClass("line-through");
    expect(
      screen.getByText("Run your first analysis"),
    ).not.toHaveClass("line-through");
  });

  it("shows the stat tiles the stats endpoint answers with, plus its own CV count", async () => {
    stub({
      stats: { analysisCount: 3, averageScore: 75, bestScore: 90 },
      cvVersions: [cv({ id: "cv1" }), cv({ id: "cv2" })],
    });

    renderWithProviders(<Dashboard />);

    const stats = within(
      (await screen.findByText("Average match score")).closest(
        "section",
      ) as HTMLElement,
    );
    expect(stats.getByText("75")).toBeInTheDocument(); // average
    expect(stats.getByText("90")).toBeInTheDocument(); // best
    expect(stats.getByText("3")).toBeInTheDocument(); // analysis count
    expect(stats.getByText("2")).toBeInTheDocument(); // cv-version count
  });

  it("excludes superseded CV versions from the cv-version count stat", async () => {
    // The CV count is the one tile the browser still works out for itself,
    // from the cv-versions list it already holds.
    stub({
      stats: { analysisCount: 2, averageScore: 75, bestScore: 90 },
      cvVersions: [
        cv({ id: "cv1", supersededById: "cv3" }),
        cv({ id: "cv2", supersededById: "cv3" }),
        cv({ id: "cv3" }),
      ],
    });

    renderWithProviders(<Dashboard />);

    const stats = within(
      (await screen.findByText("Average match score")).closest(
        "section",
      ) as HTMLElement,
    );
    expect(stats.getByText("75")).toBeInTheDocument(); // average
    expect(stats.getByText("90")).toBeInTheDocument(); // best
    expect(stats.getByText("2")).toBeInTheDocument(); // analysis count
    expect(stats.getByText("1")).toBeInTheDocument(); // cv-version count excludes cv1 and cv2
  });

  it("lists the recent analyses and the quick actions", async () => {
    stub({
      stats: { analysisCount: 1 },
      recent: [analysis()],
      cvVersions: [cv({ id: "cv1" })],
    });

    renderWithProviders(<Dashboard />);

    const recent = within(
      (await screen.findByText("Recent analyses")).closest(
        "section",
      ) as HTMLElement,
    );
    expect(recent.getByText("Backend Engineer")).toBeInTheDocument();
    expect(recent.getByText("Acme Inc · Paris")).toBeInTheDocument();

    // Each quick action's accessible name now includes its hint line (e.g.
    // "Analyse one offer A URL, a CV, a result."), so these match on the
    // leading title rather than the full string.
    expect(
      screen.getByRole("link", { name: /^Analyse one offer/ }),
    ).toHaveAttribute("href", "/analyses/new");
    expect(
      screen.getByRole("link", { name: /^Analyse several offers/ }),
    ).toHaveAttribute("href", "/analyses/new/several");
    expect(
      screen.getByRole("link", { name: /^Import a CV/ }),
    ).toHaveAttribute("href", "/cv-versions");
  });

  it("falls back to a '—' placeholder for company and location on a recent-analysis row when the offer has neither (issue #116)", async () => {
    stub({
      stats: { analysisCount: 1 },
      recent: [
        analysis({
          jobOffer: { id: "job1", title: "Backend Engineer", company: null, location: null },
        }),
      ],
      cvVersions: [cv({ id: "cv1" })],
    });

    renderWithProviders(<Dashboard />);

    const recent = within(
      (await screen.findByText("Recent analyses")).closest(
        "section",
      ) as HTMLElement,
    );
    expect(recent.getByText("— · —")).toBeInTheDocument();
  });

  it("renders the match-score trend once two analyses have been scored", async () => {
    stub({
      // The trend is drawn inside the "Recent analyses" card, so that card has
      // to be there — two queries now, one list.
      recent: [analysis()],
      stats: {
        analysisCount: 2,
        averageScore: 75,
        bestScore: 90,
        trend: [
          { requestedAt: "2026-08-01T00:00:00.000Z", score: 60 },
          { requestedAt: "2026-08-02T00:00:00.000Z", score: 90 },
        ],
      },
      cvVersions: [cv({ id: "cv1" })],
    });

    renderWithProviders(<Dashboard />);

    expect(await screen.findByText("Match score trend")).toBeInTheDocument();
  });

  it("shows the cross-Scout new-matches block and links to Agents", async () => {
    stub({
      stats: { analysisCount: 1 },
      recent: [analysis()],
      cvVersions: [cv({ id: "cv1" })],
      scouts: [
        { id: "s1", relevantFindsCount: 3 },
        { id: "s2", relevantFindsCount: 2 },
      ],
    });

    renderWithProviders(<Dashboard />);

    expect(
      await screen.findByText("5 new matches from your agents"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Review matches" }),
    ).toHaveAttribute("href", "/scouts");
  });

  it("is zero-safe and hides the block when there are no relevant finds", async () => {
    stub({
      stats: { analysisCount: 1 },
      recent: [analysis()],
      cvVersions: [cv({ id: "cv1" })],
      scouts: [{ id: "s1", relevantFindsCount: 0 }],
    });

    renderWithProviders(<Dashboard />);
    await screen.findByText("Backend Engineer");

    expect(screen.queryByText(/new matches from your agents/)).not.toBeInTheDocument();
  });

  it("shows an error state when a request fails", async () => {
    stub({ statsStatus: 500, cvVersions: [] });

    renderWithProviders(<Dashboard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load your dashboard/i,
    );
  });
});
