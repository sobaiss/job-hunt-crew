import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
    cvVersionId: "cv1",
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
    // "Completed" also appears as a status-filter option, so scope to the list.
    expect(screen.getByRole("list")).toHaveTextContent("Completed");
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

  it("narrows the list with the search box and restores it when cleared", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              jobOffer: { id: "j1", title: "Backend Engineer", company: "Acme Inc" },
            }),
            summary({
              id: "s2",
              jobOffer: { id: "j2", title: "Frontend Developer", company: "Globex" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "globex");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByText("Frontend Developer")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search"));
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Frontend Developer")).toBeInTheDocument();
  });

  it("filters by status and by CV version, and shows a no-matches message when nothing is left", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              status: "COMPLETED",
              jobOffer: { id: "j1", title: "Backend Engineer", company: "Acme" },
              cvVersion: { label: "Grad CV" },
            }),
            summary({
              id: "s2",
              status: "FAILED",
              matchScore: null,
              jobOffer: { id: "j2", title: "Frontend Developer", company: "Globex" },
              cvVersion: { label: "Senior CV" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Status"), "FAILED");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByText("Frontend Developer")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("CV version"), "Grad CV");
    expect(screen.queryByText("Frontend Developer")).not.toBeInTheDocument();
    expect(screen.getByText("No analyses match your filters.")).toBeInTheDocument();
  });

  it("sorts standalone rows by match score", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              matchScore: 40,
              requestedAt: "2026-08-09T00:00:00.000Z",
              jobOffer: { id: "j1", title: "Low Fit", company: "Acme" },
            }),
            summary({
              id: "s2",
              matchScore: 95,
              requestedAt: "2026-08-08T00:00:00.000Z",
              jobOffer: { id: "j2", title: "High Fit", company: "Globex" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    // Default is recency order: "Low Fit" (newest) precedes "High Fit".
    const low = await screen.findByText("Low Fit");
    expect(
      low.compareDocumentPosition(screen.getByText("High Fit")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.selectOptions(screen.getByLabelText("Sort by"), "score");

    expect(
      screen
        .getByText("High Fit")
        .compareDocumentPosition(screen.getByText("Low Fit")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps a SITE_SEARCH batch folded to one row while the controls filter its analyses", async () => {
    const user = userEvent.setup();
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
            summary({
              id: "s1",
              jobOffer: { id: "solo", title: "Solo Role", company: "SoloCo" },
              requestedAt: "2026-08-10T00:00:00.000Z",
            }),
            batchRow("job-1", {
              id: "b1",
              status: "COMPLETED",
              requestedAt: "2026-08-09T00:00:00.000Z",
            }),
            batchRow("job-1", {
              id: "b2",
              status: "FAILED",
              requestedAt: "2026-08-08T00:00:00.000Z",
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByText("France Travail")).toBeInTheDocument();
    expect(screen.getByText("2 offers")).toBeInTheDocument();

    // Filtering to FAILED drops the solo row and one batch analysis; the batch
    // still shows as a single folded row, now with one offer.
    await user.selectOptions(screen.getByLabelText("Status"), "FAILED");
    expect(screen.queryByText("Solo Role")).not.toBeInTheDocument();
    expect(screen.getByText("France Travail")).toBeInTheDocument();
    expect(screen.getByText("1 offer")).toBeInTheDocument();
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

  it("shows the score as a gauge with the qualitative band for the score", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    // 87 -> "Strong"; the gauge is an accessible image labelled with the score.
    expect(
      await screen.findByRole("img", { name: "Match score 87 out of 100" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Strong")).toBeInTheDocument();
  });

  it.each([
    [82, "Strong"],
    [60, "Partial"],
    [30, "Weak"],
  ])("labels a score of %i as %s", async (score, label) => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({ resultJSON: { ...RESULT, match_score: score } }),
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("renders matched skills with their evidence and missing skills with an importance tag", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({
            resultJSON: {
              ...RESULT,
              matched_skills: [
                { skill: "TypeScript", evidence: "5 years at Acme" },
              ],
              missing_skills: [
                { skill: "Kubernetes", importance: "required" as const },
                { skill: "GraphQL", importance: "nice_to_have" as const },
              ],
            },
          }),
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText(/5 years at Acme/)).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("Nice to have")).toBeInTheDocument();
  });

  it("orders improvement suggestions by priority and tags each one", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({
            resultJSON: {
              ...RESULT,
              improvement_suggestions: [
                { area: "Later", suggestion: "polish", priority: "low" as const },
                { area: "Now", suggestion: "fix", priority: "high" as const },
              ],
            },
          }),
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    const high = await screen.findByText("High priority");
    const low = screen.getByText("Low priority");
    expect(high.compareDocumentPosition(low)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
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
    expect(
      screen.getByRole("button", { name: "Run it again" }),
    ).toBeInTheDocument();
  });

  it("re-runs a FAILED analysis and links to the new one", async () => {
    const user = userEvent.setup();
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
      http.post("/api/analyses", () =>
        HttpResponse.json({ analysisId: "a2" }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    const link = await screen.findByRole("link", {
      name: /a new analysis has started/i,
    });
    expect(link).toHaveAttribute("href", "/analyses/a2");
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
