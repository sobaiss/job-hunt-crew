import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import AnalysesDashboardPage from "@/app/(app)/analyses/page";
import AnalysisDetailPage from "@/app/(app)/analyses/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "a1" }),
}));

const RESULT = {
  match_score: 87,
  matched_skills: [{ skill: "TypeScript", evidence: "5 years at Acme" }],
  missing_skills: [{ skill: "Kubernetes", importance: "required" as const }],
  strengths: ["Ships fast"],
  weaknesses: ["Thin on infra"],
  improvement_suggestions: [
    { area: "Infra", suggestion: "Add a k8s project", priority: "high" as const },
  ],
  summary: "Strong product engineer, light on platform work.",
};

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 87,
    requestedAt: "2026-08-01T00:00:00.000Z",
    ingestionJobId: null,
    ingestionJob: null,
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
    cvVersion: { label: "Grad CV" },
    ...overrides,
  };
}

function batchRow(
  ingestionJobId: string,
  overrides: Record<string, unknown> = {},
) {
  return summary({
    ingestionJobId,
    ingestionJob: { mode: "SITE_SEARCH", siteConfigId: "site-ft" },
    ...overrides,
  });
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    resultJSON: RESULT,
    errorMessage: null,
    ...overrides,
  };
}

describe("AnalysesDashboardPage", () => {
  it("shows a loading state, then a card per analysis with title, company, score and status", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(screen.getByRole("status")).toBeInTheDocument();

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText("87")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("shows an empty state when there are no analyses", async () => {
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(
      await screen.findByText("No analyses requested yet."),
    ).toBeInTheDocument();
  });

  it("folds a SITE_SEARCH batch into one row with the site, offer count, best score and a link to the batch view", async () => {
    server.use(
      http.get("/api/site-configs", () =>
        HttpResponse.json({
          siteConfigs: [
            {
              id: "site-ft",
              siteKey: "france-travail",
              displayName: "France Travail",
              integrationType: "OFFICIAL_API",
              antiBotRiskLevel: "LOW",
            },
          ],
        }),
      ),
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            batchRow("job-1", {
              id: "b1",
              matchScore: 71,
              requestedAt: "2026-08-05T00:00:00.000Z",
            }),
            batchRow("job-1", {
              id: "b2",
              matchScore: 88,
              requestedAt: "2026-08-04T00:00:00.000Z",
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByText("France Travail")).toBeInTheDocument();
    expect(screen.getByText("2 offers")).toBeInTheDocument();
    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.queryByText("71")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /France Travail/ })).toHaveAttribute(
      "href",
      "/analyses/batch/job-1",
    );
  });

  it("keeps SINGLE_URL / null-ingestionJobId analyses individual and orders grouped and individual rows by recency", async () => {
    server.use(
      http.get("/api/site-configs", () =>
        HttpResponse.json({
          siteConfigs: [
            {
              id: "site-ft",
              siteKey: "france-travail",
              displayName: "France Travail",
              integrationType: "OFFICIAL_API",
              antiBotRiskLevel: "LOW",
            },
          ],
        }),
      ),
      http.get("/api/analyses", () =>
        HttpResponse.json({
          // API returns rows recency-desc: a standalone one is newest, then
          // the batch's two rows.
          analyses: [
            summary({
              id: "s1",
              jobOffer: { id: "job9", title: "Solo Role", company: "SoloCo" },
              requestedAt: "2026-08-06T00:00:00.000Z",
            }),
            batchRow("job-1", {
              id: "b1",
              requestedAt: "2026-08-05T00:00:00.000Z",
            }),
            batchRow("job-1", {
              id: "b2",
              requestedAt: "2026-08-04T00:00:00.000Z",
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    const solo = await screen.findByText("Solo Role");
    const batch = screen.getByText("France Travail");
    expect(solo.compareDocumentPosition(batch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.getByRole("link", { name: /Solo Role/ }),
    ).toHaveAttribute("href", "/analyses/s1");
  });

  it("shows an error state when the request fails", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load your analyses/i,
    );
  });
});

describe("AnalysisDetailPage", () => {
  it("lays out the score and all five result categories", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText("Match score")).toBeInTheDocument();
    expect(screen.getByText("Matched skills")).toBeInTheDocument();
    expect(screen.getByText("Missing skills")).toBeInTheDocument();
    expect(screen.getByText("Strengths")).toBeInTheDocument();
    expect(screen.getByText("Weaknesses")).toBeInTheDocument();
    expect(screen.getByText("Improvement suggestions")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
  });

  it("shows a helpful message when the analysis has FAILED", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({
            status: "FAILED",
            resultJSON: null,
            errorMessage: "LLM timed out",
          }),
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("LLM timed out");
  });

  it("polls while non-terminal and stops once the analysis is terminal", async () => {
    let calls = 0;
    server.use(
      http.get("/api/analyses/a1", () => {
        calls += 1;
        return HttpResponse.json({
          analysis: detail({
            status: calls === 1 ? "RUNNING_CREW" : "COMPLETED",
            resultJSON: calls === 1 ? null : RESULT,
          }),
        });
      }),
    );

    vi.useFakeTimers();
    try {
      renderWithProviders(<AnalysisDetailPage />);

      await vi.waitFor(() => expect(calls).toBe(1));

      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(calls).toBe(2));

      const callsAfterTerminal = calls;
      await vi.advanceTimersByTimeAsync(12000);
      expect(calls).toBe(callsAfterTerminal);
    } finally {
      vi.useRealTimers();
    }
  });
});
