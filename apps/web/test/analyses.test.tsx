import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { server } from "./msw/server";
import { __getUrl, __setUrl } from "./next-navigation-mock";
import AnalysesDashboardPage from "@/app/(app)/analyses/page";
import AnalysisDetailPage from "@/app/(app)/analyses/[id]/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return mock;
});

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
    scoutId: null,
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme Inc",
      sourceSite: "FRANCE_TRAVAIL",
      postedAt: "2026-07-01T00:00:00.000Z",
      sourceUrl: "https://example.com/jobs/job1",
    },
    cvVersion: { label: "Grad CV" },
    ...overrides,
  };
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
  beforeEach(() => {
    __setUrl("/analyses");
  });

  afterEach(() => {
    __setUrl("/analyses");
  });

  it("shows a loading state, then a flat table row per analysis with title, company, platform, CV, score and a link", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(screen.getByRole("status")).toBeInTheDocument();

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText("France Travail")).toBeInTheDocument();
    expect(screen.getByText("Grad CV")).toBeInTheDocument();
    expect(screen.getByText("87")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the job offer" }),
    ).toHaveAttribute("href", "https://example.com/jobs/job1");
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

  it("renders every analysis as its own row, even when several share a SITE_SEARCH ingestionJobId (no batch grouping)", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "b1",
              matchScore: 71,
              ingestionJobId: "job-1",
              ingestionJob: { mode: "SITE_SEARCH", siteConfigId: "site-ft" },
              jobOffer: {
                id: "job2",
                title: "Offer One",
                company: "Acme",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/job2",
              },
            }),
            summary({
              id: "b2",
              matchScore: 88,
              ingestionJobId: "job-1",
              ingestionJob: { mode: "SITE_SEARCH", siteConfigId: "site-ft" },
              jobOffer: {
                id: "job3",
                title: "Offer Two",
                company: "Acme",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/job3",
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByText("Offer One")).toBeInTheDocument();
    expect(screen.getByText("Offer Two")).toBeInTheDocument();
    expect(screen.getByText("71")).toBeInTheDocument();
    expect(screen.getByText("88")).toBeInTheDocument();
    // Header row + the two analyses, no folded batch row in between.
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("narrows the list with the search box and restores it when cleared", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              jobOffer: {
                id: "j1",
                title: "Backend Engineer",
                company: "Acme Inc",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j1",
              },
            }),
            summary({
              id: "s2",
              jobOffer: {
                id: "j2",
                title: "Frontend Developer",
                company: "Globex",
                sourceSite: "LINKEDIN",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j2",
              },
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
              jobOffer: {
                id: "j1",
                title: "Backend Engineer",
                company: "Acme",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j1",
              },
              cvVersion: { label: "Grad CV" },
            }),
            summary({
              id: "s2",
              status: "FAILED",
              matchScore: null,
              jobOffer: {
                id: "j2",
                title: "Frontend Developer",
                company: "Globex",
                sourceSite: "LINKEDIN",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j2",
              },
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

  it("sorts by a column when its header is clicked, toggling direction on a repeat click", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              matchScore: 40,
              jobOffer: {
                id: "j1",
                title: "Low Fit",
                company: "Acme",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j1",
              },
            }),
            summary({
              id: "s2",
              matchScore: 95,
              jobOffer: {
                id: "j2",
                title: "High Fit",
                company: "Globex",
                sourceSite: "LINKEDIN",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j2",
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Low Fit");

    await user.click(screen.getByRole("button", { name: "Score" }));
    expect(
      screen
        .getByText("Low Fit")
        .compareDocumentPosition(screen.getByText("High Fit")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.click(screen.getByRole("button", { name: "Score" }));
    expect(
      screen
        .getByText("High Fit")
        .compareDocumentPosition(screen.getByText("Low Fit")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("paginates client-side, 25 per page by default, and lets the page size change", async () => {
    const user = userEvent.setup();
    const analyses = Array.from({ length: 30 }, (_, i) =>
      summary({
        id: `a${i}`,
        jobOffer: {
          id: `job${i}`,
          title: `Offer ${String(i).padStart(2, "0")}`,
          company: "Acme",
          sourceSite: "OTHER",
          postedAt: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
          sourceUrl: `https://example.com/jobs/${i}`,
        },
      }),
    );
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses })),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    await screen.findByText("Page 1 of 2");
    expect(screen.getAllByRole("row")).toHaveLength(26); // header + 25

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(6); // header + 5 remaining
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Rows per page"), "50");
    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(31); // header + all 30
  });

  it("restores search, status and sort from the URL query string on load", async () => {
    __setUrl(
      "/analyses?q=front&status=FAILED&sort=matchScore&dir=asc&page=1&pageSize=25",
    );
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              status: "COMPLETED",
              jobOffer: {
                id: "j1",
                title: "Backend Engineer",
                company: "Acme",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j1",
              },
            }),
            summary({
              id: "s2",
              status: "FAILED",
              jobOffer: {
                id: "j2",
                title: "Frontend Developer",
                company: "Globex",
                sourceSite: "LINKEDIN",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j2",
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(await screen.findByText("Frontend Developer")).toBeInTheDocument();
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveValue("front");
    expect(screen.getByLabelText("Status")).toHaveValue("FAILED");
  });

  it("writes filter changes back to the URL query string", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    await user.type(screen.getByLabelText("Search"), "backend");

    await waitFor(() => {
      const url = new URL(__getUrl(), "http://localhost");
      expect(url.searchParams.get("q")).toBe("backend");
    });
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

  it("generates and renders both documents for a completed analysis", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
      http.post("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            { id: "gd-cl", type: "COVER_LETTER", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
            { id: "gd-cv", type: "TAILORED_CV", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
          ],
        }),
      ),
      http.get("/api/generated-documents/gd-cl", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "READY",
            markdownContent: "Dear Hiring Manager, ...",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
      http.get("/api/generated-documents/gd-cv", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cv",
            type: "TAILORED_CV",
            analysisId: "a1",
            status: "READY",
            markdownContent: "# Jane Doe tailored",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Generate documents" }),
    );

    expect(await screen.findByText("Dear Hiring Manager, ...")).toBeInTheDocument();
    expect(screen.getByText("# Jane Doe tailored")).toBeInTheDocument();

    const downloadLinks = screen.getAllByRole("link", { name: /download pdf/i });
    expect(downloadLinks).toHaveLength(2);
    expect(downloadLinks[0]).toHaveAttribute("href", "/api/generated-documents/gd-cl/pdf");
    expect(downloadLinks[1]).toHaveAttribute("href", "/api/generated-documents/gd-cv/pdf");
  });

  it("shows a Download both action once both documents are ready, downloading both PDFs", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
      http.post("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            { id: "gd-cl", type: "COVER_LETTER", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
            { id: "gd-cv", type: "TAILORED_CV", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
          ],
        }),
      ),
      http.get("/api/generated-documents/gd-cl", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "READY",
            markdownContent: "Dear Hiring Manager, ...",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
      http.get("/api/generated-documents/gd-cv", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cv",
            type: "TAILORED_CV",
            analysisId: "a1",
            status: "READY",
            markdownContent: "# Jane Doe tailored",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Generate documents" }),
    );
    await screen.findByText("Dear Hiring Manager, ...");

    await user.click(await screen.findByRole("button", { name: "Download both" }));

    expect(openSpy).toHaveBeenCalledWith(
      "/api/generated-documents/gd-cl/pdf",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openSpy).toHaveBeenCalledWith(
      "/api/generated-documents/gd-cv/pdf",
      "_blank",
      "noopener,noreferrer",
    );

    openSpy.mockRestore();
  });

  it("regenerates a document and switches to polling the fresh row", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
      http.post("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            { id: "gd-cl", type: "COVER_LETTER", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
            { id: "gd-cv", type: "TAILORED_CV", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
          ],
        }),
      ),
      http.get("/api/generated-documents/gd-cl", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "READY",
            markdownContent: "Dear Hiring Manager, ...",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
      http.get("/api/generated-documents/gd-cv", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cv",
            type: "TAILORED_CV",
            analysisId: "a1",
            status: "READY",
            markdownContent: "# Jane Doe tailored",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
      http.post("/api/generated-documents/gd-cl/regenerate", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl-2",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "PENDING",
            markdownContent: null,
            errorMessage: null,
            createdAt: "2026-09-11T01:00:00.000Z",
            updatedAt: "2026-09-11T01:00:00.000Z",
          },
        }),
      ),
      http.get("/api/generated-documents/gd-cl-2", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl-2",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "READY",
            markdownContent: "Dear Hiring Manager, regenerated.",
            errorMessage: null,
            createdAt: "2026-09-11T01:00:00.000Z",
            updatedAt: "2026-09-11T01:00:00.000Z",
          },
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Generate documents" }),
    );
    await screen.findByText("Dear Hiring Manager, ...");

    const regenerateButtons = screen.getAllByRole("button", { name: "Regenerate" });
    await user.click(regenerateButtons[0]);

    expect(await screen.findByText("Dear Hiring Manager, regenerated.")).toBeInTheDocument();
  });

  it("shows a cap-reached message when regenerating exhausts the daily limit", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
      http.post("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            { id: "gd-cl", type: "COVER_LETTER", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
            { id: "gd-cv", type: "TAILORED_CV", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
          ],
        }),
      ),
      http.get("/api/generated-documents/gd-cl", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "READY",
            markdownContent: "Dear Hiring Manager, ...",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
      http.get("/api/generated-documents/gd-cv", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cv",
            type: "TAILORED_CV",
            analysisId: "a1",
            status: "READY",
            markdownContent: "# Jane Doe tailored",
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
      http.post("/api/generated-documents/gd-cl/regenerate", () =>
        HttpResponse.json({ error: "Daily document generation limit of 20 reached." }, { status: 429 }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Generate documents" }),
    );
    await screen.findByText("Dear Hiring Manager, ...");

    const regenerateButtons = screen.getAllByRole("button", { name: "Regenerate" });
    await user.click(regenerateButtons[0]);

    expect(
      await screen.findByText(/reached today's document generation limit/i),
    ).toBeInTheDocument();
  });

  it("shows an error when generation fails to start", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: detail() }),
      ),
      http.post("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Generate documents" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't start generation. Please try again.",
    );
  });

  it("marks a completed analysis as applied and links to the Application", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
      http.post("/api/applications", () =>
        HttpResponse.json({
          application: {
            id: "app-1",
            userId: "user_1",
            analysisId: "a1",
            jobOfferId: "job1",
            cvVersionId: "cv1",
            scoutId: null,
            coverLetterDocId: null,
            tailoredCvDocId: null,
            status: "DRAFT",
            appliedAt: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
            cvVersion: { label: "Grad CV" },
          },
        }),
      ),
      http.post("/api/applications/app-1/status-events", () =>
        HttpResponse.json({
          application: {
            id: "app-1",
            userId: "user_1",
            analysisId: "a1",
            jobOfferId: "job1",
            cvVersionId: "cv1",
            scoutId: null,
            coverLetterDocId: null,
            tailoredCvDocId: null,
            status: "APPLIED",
            appliedAt: "2026-09-11T00:00:00.000Z",
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
            cvVersion: { label: "Grad CV" },
          },
          statusEvent: {
            id: "se-1",
            applicationId: "app-1",
            status: "APPLIED",
            note: null,
            effectiveDate: "2026-09-11T00:00:00.000Z",
            createdAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    await user.click(await screen.findByRole("button", { name: "Mark as applied" }));

    expect(await screen.findByText("Applied")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View in Applications" })).toHaveAttribute(
      "href",
      "/applications/app-1",
    );
  });

  it("disables Apply until both generated documents are ready", async () => {
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
      http.get("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            {
              id: "gd-cl",
              type: "COVER_LETTER",
              analysisId: "a1",
              status: "READY",
              markdownContent: "Dear Hiring Manager, ...",
              errorMessage: null,
              createdAt: "2026-09-11T00:00:00.000Z",
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
            {
              id: "gd-cv",
              type: "TAILORED_CV",
              analysisId: "a1",
              status: "GENERATING",
              markdownContent: null,
              errorMessage: null,
              createdAt: "2026-09-11T00:00:00.000Z",
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("applies once both documents are ready: opens the posting, downloads both PDFs, and marks applied", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
      http.get("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            {
              id: "gd-cl",
              type: "COVER_LETTER",
              analysisId: "a1",
              status: "READY",
              markdownContent: "Dear Hiring Manager, ...",
              errorMessage: null,
              createdAt: "2026-09-11T00:00:00.000Z",
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
            {
              id: "gd-cv",
              type: "TAILORED_CV",
              analysisId: "a1",
              status: "READY",
              markdownContent: "# Jane Doe tailored",
              errorMessage: null,
              createdAt: "2026-09-11T00:00:00.000Z",
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
          ],
        }),
      ),
      http.post("/api/applications", () =>
        HttpResponse.json({
          application: {
            id: "app-1",
            userId: "user_1",
            analysisId: "a1",
            jobOfferId: "job1",
            cvVersionId: "cv1",
            scoutId: null,
            coverLetterDocId: null,
            tailoredCvDocId: null,
            status: "DRAFT",
            appliedAt: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
            cvVersion: { label: "Grad CV" },
          },
        }),
      ),
      http.post("/api/applications/app-1/status-events", () =>
        HttpResponse.json({
          application: {
            id: "app-1",
            userId: "user_1",
            analysisId: "a1",
            jobOfferId: "job1",
            cvVersionId: "cv1",
            scoutId: null,
            coverLetterDocId: null,
            tailoredCvDocId: null,
            status: "APPLIED",
            appliedAt: "2026-09-11T00:00:00.000Z",
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
            cvVersion: { label: "Grad CV" },
          },
          statusEvent: {
            id: "se-1",
            applicationId: "app-1",
            status: "APPLIED",
            note: null,
            effectiveDate: "2026-09-11T00:00:00.000Z",
            createdAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    const applyButton = await screen.findByRole("button", { name: "Apply" });
    await waitFor(() => expect(applyButton).toBeEnabled());
    await user.click(applyButton);

    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/jobs/job1",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openSpy).toHaveBeenCalledWith(
      "/api/generated-documents/gd-cl/pdf",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openSpy).toHaveBeenCalledWith(
      "/api/generated-documents/gd-cv/pdf",
      "_blank",
      "noopener,noreferrer",
    );
    expect(await screen.findByText("Applied")).toBeInTheDocument();

    openSpy.mockRestore();
  });
});
