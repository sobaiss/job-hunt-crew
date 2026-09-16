import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
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
    applicationStatus: null,
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme Inc",
      location: "Paris",
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

  it("shows a loading state, then a flat table row per analysis with title, company, location, platform, CV, score and a link", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    expect(screen.getByRole("status")).toBeInTheDocument();

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText("Paris")).toBeInTheDocument();
    expect(screen.getByText("France Travail")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Grad CV" })).toBeInTheDocument();
    expect(screen.getByText("87")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the job offer" }),
    ).toHaveAttribute("href", "https://example.com/jobs/job1");
  });

  it("falls back to a '—' placeholder for company, location and publication date when the offer has none, in both the table and card layout (issue #116)", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              jobOffer: {
                ...summary().jobOffer,
                company: null,
                location: null,
                postedAt: null,
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    // Company, location and posted-at cells each render the "—" placeholder,
    // never a blank cell or a literal "null"/"None" string.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("null")).not.toBeInTheDocument();
    expect(screen.queryByText("None")).not.toBeInTheDocument();
  });

  it("collapses columns in the order CV, Platform, Posted, Company as space runs out, keeping Position/Score/Status/Link always visible (issue #69)", async () => {
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [summary()] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    const cvHeader = screen.getByRole("columnheader", { name: "CV" });
    const platformHeader = screen.getByRole("columnheader", { name: "Platform" });
    const postedHeader = screen.getByRole("columnheader", { name: "Posted" });
    const companyHeader = screen.getByRole("columnheader", { name: "Company" });

    // Drops first (needs the widest viewport) -> drops last, in the order the
    // issue specifies: CV, then Platform, then Posted, then Company.
    expect(cvHeader.className).toContain("hidden xl:table-cell");
    expect(platformHeader.className).toContain("hidden lg:table-cell");
    expect(postedHeader.className).toContain("hidden md:table-cell");
    expect(companyHeader.className).toContain("hidden sm:table-cell");
    // The row's cells collapse in step with their header.
    expect(screen.getByRole("cell", { name: "Acme Inc" }).className).toContain(
      "hidden sm:table-cell",
    );

    for (const header of [
      screen.getByRole("columnheader", { name: "Position" }),
      screen.getByRole("columnheader", { name: "Score" }),
      screen.getByRole("columnheader", { name: "Status" }),
      screen.getByRole("columnheader", { name: "Link" }),
    ]) {
      expect(header.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    }
  });

  it("replaces the table with a stacked card per Analysis below ~640px, keeping the same click/select/link behavior (issue #69)", async () => {
    const user = userEvent.setup();
    const originalMatchMedia = window.matchMedia;
    try {
      window.matchMedia = ((query: string) =>
        ({
          matches: query === "(max-width: 639px)",
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList) as typeof window.matchMedia;

      server.use(
        http.get("/api/analyses", () => HttpResponse.json({ analyses: [detail()] })),
      );

      renderWithProviders(<AnalysesDashboardPage />);

      const title = await screen.findByText("Backend Engineer");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      const card = within(title.closest("[tabindex]") as HTMLElement);
      expect(card.getByText("Acme Inc", { exact: false })).toBeInTheDocument();
      expect(card.getByText("Paris", { exact: false })).toBeInTheDocument();
      expect(card.getByText("87")).toBeInTheDocument();
      expect(card.getByText("To apply")).toBeInTheDocument();

      // Same click behavior as a table row: opens the Quick view.
      await user.click(screen.getByText("Backend Engineer"));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Same Lien behavior: opens the offer without the Quick view.
      await user.click(screen.getByRole("link", { name: "Open the job offer" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Same select behavior, feeding the same bulk-actions bar.
      await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("shows a Tracking status badge for a COMPLETED analysis and a pipeline badge otherwise (issue #64)", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              status: "COMPLETED",
              applicationStatus: null,
              jobOffer: {
                id: "j1",
                title: "To Apply Offer",
                company: "Acme",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j1",
              },
            }),
            summary({
              id: "s2",
              status: "RUNNING_CREW",
              matchScore: null,
              jobOffer: {
                id: "j2",
                title: "Still Running Offer",
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

    expect(await screen.findByText("To Apply Offer")).toBeInTheDocument();
    // COMPLETED with no Application yet -> the "To apply" Tracking status bucket.
    expect(screen.getByRole("cell", { name: "To apply" })).toBeInTheDocument();
    // Still running -> its raw pipeline state, not a Tracking status bucket.
    expect(screen.getByRole("cell", { name: "Running" })).toBeInTheDocument();

    // The pipeline-only row is excluded from every specific Tracking status
    // filter, but stays visible under "All statuses" (the default).
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Status"), "TO_APPLY");
    expect(screen.queryByText("Still Running Offer")).not.toBeInTheDocument();
    expect(screen.getByText("To Apply Offer")).toBeInTheDocument();
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
              status: "COMPLETED",
              applicationStatus: "REJECTED",
              matchScore: 55,
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

    await user.selectOptions(screen.getByLabelText("Status"), "REJECTED");
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
      "/analyses?q=front&status=REJECTED&sort=matchScore&dir=asc&page=1&pageSize=25",
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
              status: "COMPLETED",
              applicationStatus: "REJECTED",
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
    expect(screen.getByLabelText("Status")).toHaveValue("REJECTED");
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

  it("selects rows via the header checkbox, scoped to the current page only (issue #67)", async () => {
    const user = userEvent.setup();
    const analyses = Array.from({ length: 30 }, (_, i) =>
      summary({
        id: `a${i}`,
        jobOffer: {
          id: `job${i}`,
          title: `Offer ${String(i).padStart(2, "0")}`,
          company: "Acme",
          sourceSite: "OTHER",
          // Descending, one distinct day per row (no ties) — the default
          // sort is postedAt desc, so this keeps "Offer 00" deterministically
          // on page 1 instead of depending on tie-break ordering.
          postedAt: `2026-07-${String(30 - i).padStart(2, "0")}T00:00:00.000Z`,
          sourceUrl: `https://example.com/jobs/${i}`,
        },
      }),
    );
    server.use(http.get("/api/analyses", () => HttpResponse.json({ analyses })));

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Page 1 of 2");

    await user.click(screen.getByLabelText("Select all on this page"));
    expect(screen.getByText("25 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select Offer 00" }),
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2 of 2");
    // The next page's rows are unaffected by the previous page's selection.
    expect(
      screen.getByRole("checkbox", { name: "Select all on this page" }),
    ).not.toBeChecked();
  });

  it("offers to extend the selection to every row matching the filters, across pages (issue #67)", async () => {
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
    server.use(http.get("/api/analyses", () => HttpResponse.json({ analyses })));

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Page 1 of 2");

    await user.click(screen.getByLabelText("Select all on this page"));
    expect(
      screen.getByRole("button", { name: "Select all 30 matching your filters" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Select all 30 matching your filters" }),
    );
    expect(screen.getByText("30 selected")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select all 30 matching your filters" }),
    ).not.toBeInTheDocument();
  });

  it("shows the bulk-actions bar only while something is selected, offering Tracking status changes and CSV export (issue #67)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1" }),
            summary({
              id: "s2",
              jobOffer: { ...summary().jobOffer, id: "job-s2", title: "Frontend Engineer" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));

    expect(screen.getByRole("button", { name: "In progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rejected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accepted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdrawn" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "To apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("bulk-changes the Tracking status for the selection, lazily creating Applications, and reports a partial failure (issue #67)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", jobOffer: { ...summary().jobOffer, id: "j1", title: "Offer One" } }),
            summary({ id: "s2", jobOffer: { ...summary().jobOffer, id: "j2", title: "Offer Two" } }),
          ],
        }),
      ),
      http.post("/api/applications", async ({ request }) => {
        const body = (await request.json()) as { analysisId: string };
        if (body.analysisId === "s2") {
          return HttpResponse.json({ error: "boom" }, { status: 500 });
        }
        return HttpResponse.json({
          application: {
            id: "app-1",
            userId: "user_1",
            analysisId: body.analysisId,
            jobOfferId: "j1",
            cvVersionId: "cv1",
            scoutId: null,
            coverLetterDocId: null,
            tailoredCvDocId: null,
            status: "DRAFT",
            appliedAt: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "j1", title: "Offer One", company: "Acme Inc" },
            cvVersion: { label: "Grad CV" },
          },
        });
      }),
      http.post("/api/applications/app-1/status-events", () =>
        HttpResponse.json({
          application: {
            id: "app-1",
            userId: "user_1",
            analysisId: "s1",
            jobOfferId: "j1",
            cvVersionId: "cv1",
            scoutId: null,
            coverLetterDocId: null,
            tailoredCvDocId: null,
            status: "APPLIED",
            appliedAt: "2026-09-11T00:00:00.000Z",
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "j1", title: "Offer One", company: "Acme Inc" },
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

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Offer One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(screen.getByRole("button", { name: "In progress" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 2");
  });

  it("exports the selected rows to CSV without a network request (issue #67)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary({ id: "s1" })] }),
      ),
    );

    const blobUrl = "blob:mock-url";
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => blobUrl);
    const revokeObjectURL = vi.fn();
    // jsdom doesn't implement these at all, so there's nothing to spy on —
    // assign them directly and restore by deleting afterwards.
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    const text = await blob.text();
    expect(text).toContain("Backend Engineer");
    expect(text).toContain("https://example.com/jobs/job1");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);

    clickSpy.mockRestore();
    // @ts-expect-error -- jsdom has no implementation to restore to.
    delete URL.createObjectURL;
    // @ts-expect-error -- jsdom has no implementation to restore to.
    delete URL.revokeObjectURL;
  });

  it("disables the bulk generate confirm when the selection would exceed the remaining quota (issue #68)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", jobOffer: { ...summary().jobOffer, id: "j1", title: "Offer One" } }),
            summary({ id: "s2", jobOffer: { ...summary().jobOffer, id: "j2", title: "Offer Two" } }),
          ],
        }),
      ),
      http.get("/api/generated-documents/quota", () =>
        HttpResponse.json({ quota: { cap: 20, used: 17, remaining: 3 } }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Offer One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(screen.getByRole("button", { name: "Generate documents" }));

    expect(await screen.findByText("Generate for 2 offers — 3 remaining today")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(
      screen.getByText("Not enough remaining quota today for this many offers."),
    ).toBeInTheDocument();
  });

  it("bulk-generates documents for the selection and reflects a live ready/failed progress summary (issue #68)", async () => {
    const user = userEvent.setup();
    const document = (id: string, status: string) => ({
      id,
      type: id.endsWith("cl") ? "COVER_LETTER" : "TAILORED_CV",
      analysisId: id.startsWith("gd1") ? "s1" : "s2",
      status,
      markdownContent: status === "READY" ? "content" : null,
      errorMessage: status === "FAILED" ? "Generation failed" : null,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    });
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", jobOffer: { ...summary().jobOffer, id: "j1", title: "Offer One" } }),
            summary({ id: "s2", jobOffer: { ...summary().jobOffer, id: "j2", title: "Offer Two" } }),
          ],
        }),
      ),
      http.get("/api/generated-documents/quota", () =>
        HttpResponse.json({ quota: { cap: 20, used: 0, remaining: 20 } }),
      ),
      http.post("/api/analyses/s1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [document("gd1-cl", "PENDING"), document("gd1-cv", "PENDING")],
        }),
      ),
      http.post("/api/analyses/s2/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [document("gd2-cl", "PENDING"), document("gd2-cv", "PENDING")],
        }),
      ),
      http.get("/api/generated-documents/gd1-cl", () =>
        HttpResponse.json({ generatedDocument: document("gd1-cl", "READY") }),
      ),
      http.get("/api/generated-documents/gd1-cv", () =>
        HttpResponse.json({ generatedDocument: document("gd1-cv", "READY") }),
      ),
      http.get("/api/generated-documents/gd2-cl", () =>
        HttpResponse.json({ generatedDocument: document("gd2-cl", "FAILED") }),
      ),
      http.get("/api/generated-documents/gd2-cv", () =>
        HttpResponse.json({ generatedDocument: document("gd2-cv", "FAILED") }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Offer One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(screen.getByRole("button", { name: "Generate documents" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("2 ready, 2 failed, 4 total")).toBeInTheDocument();
  });

  it("clears the selection when the search term, Tracking status filter, or sort changes (issue #67)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary({ id: "s1" })] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "x");
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
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

  it("opens the Quick view when a row is clicked, showing the full result breakdown and status, plus links to the full analysis and the comparison (issue #65, widened in #70)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            detail({
              resultJSON: {
                ...RESULT,
                matched_skills: [
                  { skill: "TypeScript", evidence: "5 years at Acme" },
                ],
                missing_skills: [
                  { skill: "Kubernetes", importance: "required" },
                  { skill: "Terraform", importance: "required" },
                  { skill: "GraphQL", importance: "nice_to_have" },
                  { skill: "Rust", importance: "nice_to_have" },
                ],
                strengths: ["Ships fast"],
                weaknesses: ["Thin on infra"],
                improvement_suggestions: [
                  { area: "Infra", suggestion: "Add a k8s project", priority: "high" },
                ],
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(
      quickView.getByRole("heading", { name: "Backend Engineer" }),
    ).toBeInTheDocument();
    expect(
      quickView.getByRole("img", { name: "Match score 87 out of 100" }),
    ).toBeInTheDocument();
    expect(
      quickView.getByText("Strong product engineer, light on platform work."),
    ).toBeInTheDocument();
    expect(quickView.getByText("TypeScript")).toBeInTheDocument();
    expect(quickView.getByText(/5 years at Acme/)).toBeInTheDocument();
    // No top-3 cap anymore — the full missing-skills list renders.
    expect(quickView.getByText("Kubernetes")).toBeInTheDocument();
    expect(quickView.getByText("Terraform")).toBeInTheDocument();
    expect(quickView.getByText("GraphQL")).toBeInTheDocument();
    expect(quickView.getByText("Rust")).toBeInTheDocument();
    expect(quickView.getByText("Ships fast")).toBeInTheDocument();
    expect(quickView.getByText("Thin on infra")).toBeInTheDocument();
    expect(quickView.getByText(/Add a k8s project/)).toBeInTheDocument();
    expect(quickView.getByText("To apply")).toBeInTheDocument();

    expect(
      quickView.getByRole("link", { name: "View full analysis" }),
    ).toHaveAttribute("href", "/analyses/a1");
    expect(
      quickView.getByRole("link", { name: "Compare with other CVs" }),
    ).toHaveAttribute("href", "/analyses/compare/job1");
  });

  it("shows the offer's location in the Quick view, falling back to a placeholder for company and location when missing (issue #116)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            detail({
              jobOffer: {
                ...summary().jobOffer,
                company: null,
                location: null,
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(quickView.getByText("— · —")).toBeInTheDocument();
  });

  it("does not open the Quick view when the Lien icon is clicked", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByRole("link", { name: "Open the job offer" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the Quick view on Escape and returns focus to the triggering row", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    const row = (await screen.findByText("Backend Engineer")).closest("tr");
    if (!row) throw new Error("row not found");

    await user.click(row);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(row);
  });

  it("opens the offer in a new tab from the Quick view's \"View job offer\" link (issue #66)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [detail()] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    const offerLink = quickView.getByRole("link", { name: "View job offer" });
    expect(offerLink).toHaveAttribute("href", "https://example.com/jobs/job1");
    expect(offerLink).toHaveAttribute("target", "_blank");
  });

  it("does not offer a \"To apply\" Tracking status transition from the Quick view (issue #66)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [detail()] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByText("To apply");
    expect(
      quickView.queryByRole("button", { name: "To apply" }),
    ).not.toBeInTheDocument();
  });

  it("changes the Tracking status from the Quick view, lazily creating the Application, and updates the badge (issue #66)", async () => {
    const user = userEvent.setup();
    let applicationStatus: string | null = null;
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ applicationStatus })] }),
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
      http.post("/api/applications/app-1/status-events", () => {
        applicationStatus = "APPLIED";
        return HttpResponse.json({
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
        });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByText("To apply");

    await user.click(quickView.getByRole("button", { name: "In progress" }));

    await waitFor(() => expect(quickView.getByText("In progress")).toBeInTheDocument());
    expect(quickView.queryByText("To apply")).not.toBeInTheDocument();
  });

  it("triggers document generation from the Quick view, reflecting pending status (issue #66)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [detail()] })),
      http.post("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({
          generatedDocuments: [
            {
              id: "gd-cl",
              type: "COVER_LETTER",
              analysisId: "a1",
              status: "PENDING",
              markdownContent: null,
              errorMessage: null,
              createdAt: "2026-09-11T00:00:00.000Z",
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
            {
              id: "gd-cv",
              type: "TAILORED_CV",
              analysisId: "a1",
              status: "PENDING",
              markdownContent: null,
              errorMessage: null,
              createdAt: "2026-09-11T00:00:00.000Z",
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
          ],
        }),
      ),
      http.get("/api/generated-documents/gd-cl", () =>
        HttpResponse.json({
          generatedDocument: {
            id: "gd-cl",
            type: "COVER_LETTER",
            analysisId: "a1",
            status: "PENDING",
            markdownContent: null,
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
            status: "PENDING",
            markdownContent: null,
            errorMessage: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(
      quickView.getByRole("button", { name: "Generate documents" }),
    );

    expect(await quickView.findAllByText("Queued…")).toHaveLength(2);
  });

  it("refetches the analyses list on demand, showing a busy state while in flight, without resetting search or filters (issue #121)", async () => {
    const user = userEvent.setup();
    let callCount = 0;
    let resolveSecondCall: () => void = () => {};
    const secondCallGate = new Promise<void>((resolve) => {
      resolveSecondCall = resolve;
    });
    server.use(
      http.get("/api/analyses", async () => {
        callCount += 1;
        const isRefresh = callCount === 2;
        if (isRefresh) {
          await secondCallGate;
        }
        return HttpResponse.json({
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
                title: callCount >= 2 ? "Frontend Developer (updated)" : "Frontend Developer",
                company: "Globex",
                sourceSite: "LINKEDIN",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j2",
              },
            }),
          ],
        });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    expect(await screen.findByText("Frontend Developer")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "developer");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();

    resolveSecondCall();
    await waitFor(() => expect(refreshButton).not.toBeDisabled());

    expect(callCount).toBe(2);
    expect(screen.getByText("Frontend Developer (updated)")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveValue("developer");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
  });
});

describe("AnalysisDetailPage", () => {
  it("shows the offer's company and location, falling back to a placeholder for either when missing (issue #116)", async () => {
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText("Acme Inc · Paris")).toBeInTheDocument();
  });

  it("shows the placeholder for company and location when the offer has neither (issue #116)", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({
            jobOffer: { ...summary().jobOffer, company: null, location: null },
          }),
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText("— · —")).toBeInTheDocument();
  });

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
    expect(
      screen.getByRole("heading", { level: 1, name: "Jane Doe tailored" }),
    ).toBeInTheDocument();

    const downloadLinks = screen.getAllByRole("link", { name: /^download$/i });
    expect(downloadLinks).toHaveLength(2);
    expect(downloadLinks[0]).toHaveAttribute(
      "href",
      "/api/generated-documents/gd-cl/download?format=pdf",
    );
    expect(downloadLinks[1]).toHaveAttribute(
      "href",
      "/api/generated-documents/gd-cv/download?format=pdf",
    );
  });

  it("lets each document card pick its own download format independently", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
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

    await user.click(await screen.findByRole("button", { name: "Generate documents" }));
    await screen.findByText("Dear Hiring Manager, ...");

    const formatSelects = screen.getAllByRole("combobox");
    expect(formatSelects).toHaveLength(2);
    await user.selectOptions(formatSelects[0]!, "docx");

    const downloadLinks = screen.getAllByRole("link", { name: /^download$/i });
    expect(downloadLinks[0]).toHaveAttribute(
      "href",
      "/api/generated-documents/gd-cl/download?format=docx",
    );
    expect(downloadLinks[1]).toHaveAttribute(
      "href",
      "/api/generated-documents/gd-cv/download?format=pdf",
    );
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
      "/api/generated-documents/gd-cl/download?format=pdf",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openSpy).toHaveBeenCalledWith(
      "/api/generated-documents/gd-cv/download?format=pdf",
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
      "/api/generated-documents/gd-cl/download",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openSpy).toHaveBeenCalledWith(
      "/api/generated-documents/gd-cv/download",
      "_blank",
      "noopener,noreferrer",
    );
    expect(await screen.findByText("Applied")).toBeInTheDocument();

    openSpy.mockRestore();
  });
});
