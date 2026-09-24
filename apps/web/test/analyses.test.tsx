import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { Session } from "next-auth";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import { __getUrl, __setUrl } from "./next-navigation-mock";
import AnalysesDashboardPage from "@/app/(app)/analyses/page";
import AnalysisDetailPage from "@/app/(app)/analyses/[id]/page";

const INTERNAL_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "user_1", name: "Ada Lovelace", email: "ada@example.com", role: "INTERNAL" },
};

const EXTERNAL_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "candidate_1", name: "Ada Lovelace", email: "ada@example.com", role: "EXTERNAL" },
};

function cvVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv1",
    label: "Grad CV",
    fileName: "cv.pdf",
    fileType: "PDF",
    fileSizeBytes: 1024,
    isDefault: false,
    conversionStatus: "CONVERTED",
    conversionError: null,
    supersededById: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

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
    requeuedAt: null,
    // Derived server-side (docs/adr/0032); `true` is what makes the
    // "interrupted / run it again" block appear.
    stuck: false,
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

const PENDING_DOCUMENTS = [
  { id: "gd-cl", type: "COVER_LETTER", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
  { id: "gd-cv", type: "TAILORED_CV", analysisId: "a1", status: "PENDING", markdownContent: null, errorMessage: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" },
];

/** The generation endpoint as services/api implements it since
 *  docs/adr/0031: a `type` in the body produces just that document, its
 *  absence (the bulk action, the Admin table) still produces both. */
function pendingDocumentsPost() {
  return http.post("/api/analyses/a1/generated-documents", async ({ request }) => {
    const body = await request.text();
    const type = body ? (JSON.parse(body) as { type?: string }).type : undefined;
    return HttpResponse.json({
      generatedDocuments: type
        ? PENDING_DOCUMENTS.filter((d) => d.type === type)
        : PENDING_DOCUMENTS,
    });
  });
}

/** Generation is per document now, so a test that wants both asks twice. */
async function generateBothDocuments(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Generate the cover letter" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Generate the tailored CV" }),
  );
}

/** Three distinct offers for the Quick view's navigation tests, dated so the
 *  default `postedAt`-descending sort ranks them A, B, C — and all older than
 *  `summary()`'s own offer, which therefore outranks them when mixed in. */
function navigableOffer(letter: string, day: number) {
  return detail({
    id: `a-${letter}`,
    jobOffer: {
      id: `job-${letter}`,
      title: `Offer ${letter}`,
      company: "Acme Inc",
      location: "Paris",
      sourceSite: "OTHER",
      postedAt: `2026-06-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      sourceUrl: `https://example.com/jobs/${letter}`,
    },
  });
}

const OFFER_A = navigableOffer("A", 5);
const OFFER_B = navigableOffer("B", 4);
const OFFER_C = navigableOffer("C", 3);

/** Every filter but Search and Status is folded away behind "More filters",
 *  so a test that drives one of them opens the panel first. */
async function openMoreFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /More filters/ }));
}

/** Status and Platform are checkbox menus, so choosing means opening the menu
 *  and ticking. The trigger's accessible name is the filter's label followed
 *  by its current value ("Status All statuses"); the trailing space in the
 *  pattern is what keeps it apart from the "Platform" column's own sort
 *  button, whose name is that word alone. */
function filterTrigger(filter: "Status" | "Platform") {
  return screen.getByRole("button", { name: new RegExp(`^${filter} .`) });
}

async function tickFilterValues(
  user: ReturnType<typeof userEvent.setup>,
  filter: "Status" | "Platform",
  ...values: string[]
) {
  await user.click(filterTrigger(filter));
  for (const value of values) {
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: value }),
    );
  }
  await user.keyboard("{Escape}");
}

/** Empties one checkbox menu through its own "Clear all" item. */
async function clearFilter(
  user: ReturnType<typeof userEvent.setup>,
  filter: "Status" | "Platform",
) {
  await user.click(filterTrigger(filter));
  await user.click(await screen.findByRole("menuitem", { name: "Clear all" }));
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
    expect(screen.getByRole("cell", { name: "France Travail" })).toBeInTheDocument();
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

  it("truncates a long Poste/Entreprise/Localisation value with an ellipsis and reveals the full text in a tooltip on hover or focus (issue #128)", async () => {
    const user = userEvent.setup();
    const longTitle =
      "Senior Staff Backend Engineer for the Platform Reliability Team";
    const longCompany = "A Very Long International Holding Company";
    const longLocation = "San Francisco Bay Area, California";
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              jobOffer: {
                ...summary().jobOffer,
                title: longTitle,
                company: longCompany,
                location: longLocation,
              },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    const truncatedTitle = await screen.findByText(
      `${longTitle.slice(0, 50)}…`,
    );
    const truncatedCompany = screen.getByText(`${longCompany.slice(0, 15)}…`);
    const truncatedLocation = screen.getByText(
      `${longLocation.slice(0, 15)}…`,
    );
    expect(truncatedTitle).toBeInTheDocument();
    expect(truncatedCompany).toBeInTheDocument();
    expect(truncatedLocation).toBeInTheDocument();

    truncatedCompany.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(longCompany);

    await user.hover(truncatedLocation);
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 2000 }),
    ).toHaveTextContent(longLocation);
  });

  it("renders a Poste/Entreprise/Localisation value at or under its limit unchanged, with no tooltip (issue #128)", async () => {
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [summary()] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText("Paris")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows every column visible by default, with Position/Status/Link absent from the Columns menu (issue #129)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [summary()] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    for (const name of [
      "Position",
      "ID",
      "Company",
      "Location",
      "Platform",
      "Posted",
      "Requested",
      "CV",
      "Score",
      "Status",
      "Link",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: "Columns" }));
    for (const name of [
      "ID",
      "Company",
      "Location",
      "Platform",
      "Posted",
      "Requested",
      "CV",
      "Score",
    ]) {
      expect(
        screen.getByRole("menuitemcheckbox", { name }),
      ).toBeInTheDocument();
    }
    for (const name of ["Position", "Status", "Link"]) {
      expect(
        screen.queryByRole("menuitemcheckbox", { name }),
      ).not.toBeInTheDocument();
    }
  });

  it("toggles a column's visibility independently and persists the choice across a remount, restored by Réinitialiser (issue #129)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [summary()] })),
    );

    const { unmount } = renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Company" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("columnheader", { name: "Company" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Location" })).toBeInTheDocument();
    expect(screen.queryByText("Acme Inc")).not.toBeInTheDocument();

    unmount();
    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");
    expect(screen.queryByRole("columnheader", { name: "Company" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset" }));
    expect(screen.getByRole("columnheader", { name: "Company" })).toBeInTheDocument();
  });

  it("keeps sorting on a column after it's hidden (issue #129)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "a1",
              jobOffer: { ...summary().jobOffer, title: "Zeta Offer", company: "Zeta Co" },
            }),
            summary({
              id: "a2",
              jobOffer: { ...summary().jobOffer, title: "Alpha Offer", company: "Alpha Co" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Zeta Offer");

    await user.click(screen.getByRole("columnheader", { name: "Company" }).querySelector("button")!);
    expect(__getUrl()).toContain("sort=company");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Company" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("columnheader", { name: "Company" })).not.toBeInTheDocument();
    expect(__getUrl()).toContain("sort=company");
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
    await tickFilterValues(user, "Status", "To apply");
    expect(screen.queryByText("Still Running Offer")).not.toBeInTheDocument();
    expect(screen.getByText("To Apply Offer")).toBeInTheDocument();
  });

  it("filters by the Échouée/Failed status, which now has its own filter bucket (issue #172)", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              status: "FAILED",
              matchScore: null,
              jobOffer: { ...summary().jobOffer, id: "j1", title: "Failed Offer" },
            }),
            summary({
              id: "s2",
              status: "COMPLETED",
              jobOffer: { ...summary().jobOffer, id: "j2", title: "Completed Offer" },
            }),
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Failed Offer");

    expect(screen.getByRole("cell", { name: "Failed" })).toBeInTheDocument();

    await tickFilterValues(user, "Status", "Failed");
    expect(screen.getByText("Failed Offer")).toBeInTheDocument();
    expect(screen.queryByText("Completed Offer")).not.toBeInTheDocument();
  });

  it("filters by the En attente/Pending status, which has a bucket of its own too", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              status: "PENDING",
              matchScore: null,
              // A stuck Analysis sits here for good until it is requeued
              // (docs/adr/0032) — the case this bucket exists to surface.
              stuck: true,
              jobOffer: { ...summary().jobOffer, id: "j1", title: "Pending Offer" },
            }),
            summary({
              id: "s2",
              status: "COMPLETED",
              jobOffer: { ...summary().jobOffer, id: "j2", title: "Completed Offer" },
            }),
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Pending Offer");

    expect(screen.getByRole("cell", { name: "Pending" })).toBeInTheDocument();

    await tickFilterValues(user, "Status", "Pending");
    expect(screen.getByText("Pending Offer")).toBeInTheDocument();
    expect(screen.queryByText("Completed Offer")).not.toBeInTheDocument();
  });

  it("keeps several statuses at once, naming the selection on the trigger and writing them to one URL param", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              status: "FAILED",
              matchScore: null,
              jobOffer: { ...summary().jobOffer, id: "j1", title: "Failed Offer" },
            }),
            summary({
              id: "s2",
              status: "COMPLETED",
              jobOffer: { ...summary().jobOffer, id: "j2", title: "To Apply Offer" },
            }),
            summary({
              id: "s3",
              status: "COMPLETED",
              applicationStatus: "REJECTED",
              jobOffer: { ...summary().jobOffer, id: "j3", title: "Rejected Offer" },
            }),
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Failed Offer");

    // A single selection names itself; two report their count.
    await tickFilterValues(user, "Status", "To apply");
    expect(filterTrigger("Status")).toHaveAccessibleName("Status To apply");

    await tickFilterValues(user, "Status", "Failed");
    expect(filterTrigger("Status")).toHaveAccessibleName("Status 2 statuses");

    expect(screen.getByText("To Apply Offer")).toBeInTheDocument();
    expect(screen.getByText("Failed Offer")).toBeInTheDocument();
    expect(screen.queryByText("Rejected Offer")).not.toBeInTheDocument();

    await waitFor(() => {
      const url = new URL(__getUrl(), "http://localhost");
      expect(url.searchParams.get("status")).toBe("TO_APPLY,FAILED");
    });

    // Unticking one leaves the other in force, rather than clearing both.
    await tickFilterValues(user, "Status", "Failed");
    expect(filterTrigger("Status")).toHaveAccessibleName("Status To apply");
    expect(screen.queryByText("Failed Offer")).not.toBeInTheDocument();
    expect(screen.getByText("To Apply Offer")).toBeInTheDocument();
  });

  it("combines several platforms, counting the filter once on the 'More filters' toggle", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              jobOffer: {
                ...summary().jobOffer,
                id: "j1",
                title: "LinkedIn Offer",
                sourceSite: "LINKEDIN",
              },
            }),
            summary({
              id: "s2",
              jobOffer: {
                ...summary().jobOffer,
                id: "j2",
                title: "HelloWork Offer",
                sourceSite: "HELLOWORK",
              },
            }),
            summary({
              id: "s3",
              jobOffer: {
                ...summary().jobOffer,
                id: "j3",
                title: "Indeed Offer",
                sourceSite: "INDEED",
              },
            }),
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("LinkedIn Offer");

    await openMoreFilters(user);
    await tickFilterValues(user, "Platform", "LinkedIn", "HelloWork");

    expect(screen.getByText("LinkedIn Offer")).toBeInTheDocument();
    expect(screen.getByText("HelloWork Offer")).toBeInTheDocument();
    expect(screen.queryByText("Indeed Offer")).not.toBeInTheDocument();

    // Two values ticked, one filter narrowing: the toggle counts filters, so
    // a closed panel never overstates what is hiding inside it.
    expect(
      screen.getByRole("button", { name: "More filters (1)" }),
    ).toBeInTheDocument();
  });

  it("filters by the requestedAt range (issue #172)", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              requestedAt: "2026-07-05T00:00:00.000Z",
              jobOffer: { ...summary().jobOffer, id: "j1", title: "Early Offer" },
            }),
            summary({
              id: "s2",
              requestedAt: "2026-08-15T00:00:00.000Z",
              jobOffer: { ...summary().jobOffer, id: "j2", title: "Late Offer" },
            }),
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Early Offer");

    await openMoreFilters(user);
    await user.type(screen.getByLabelText("Requested from"), "2026-08-01");
    expect(screen.queryByText("Early Offer")).not.toBeInTheDocument();
    expect(screen.getByText("Late Offer")).toBeInTheDocument();
  });

  it("shows the id column with a copy button (issue #172)", async () => {
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [summary({ id: "a1" })] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    expect(screen.getByText("a1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
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

    await tickFilterValues(user, "Status", "Rejected");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByText("Frontend Developer")).toBeInTheDocument();

    await openMoreFilters(user);
    await user.selectOptions(screen.getByLabelText("CV version"), "Grad CV");
    expect(screen.queryByText("Frontend Developer")).not.toBeInTheDocument();
    expect(screen.getByText("No analyses match your filters.")).toBeInTheDocument();
  });

  it("filters by platform and by location, combining with each other and the existing filters (issue #125)", async () => {
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
                company: "Acme",
                location: "Paris",
                sourceSite: "FRANCE_TRAVAIL",
                postedAt: "2026-07-01T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j1",
              },
              cvVersion: { label: "Grad CV" },
            }),
            summary({
              id: "s2",
              jobOffer: {
                id: "j2",
                title: "Frontend Developer",
                company: "Globex",
                location: "Lyon",
                sourceSite: "LINKEDIN",
                postedAt: "2026-07-02T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j2",
              },
              cvVersion: { label: "Grad CV" },
            }),
            summary({
              id: "s3",
              jobOffer: {
                id: "j3",
                title: "Platform Engineer",
                company: "Initech",
                location: "Paris",
                sourceSite: "HELLOWORK",
                postedAt: "2026-07-03T00:00:00.000Z",
                sourceUrl: "https://example.com/jobs/j3",
              },
              cvVersion: { label: "Grad CV" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();

    await openMoreFilters(user);

    // Platform options include a correctly-translated HelloWork label, not a
    // raw enum value.
    // The menu lists a correctly-translated HelloWork label, not a raw enum
    // value.
    await user.click(filterTrigger("Platform"));
    expect(
      await screen.findByRole("menuitemcheckbox", { name: "HelloWork" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await tickFilterValues(user, "Platform", "HelloWork");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Frontend Developer")).not.toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();

    await clearFilter(user, "Platform");
    await user.type(screen.getByLabelText("Location"), "par");
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Frontend Developer")).not.toBeInTheDocument();

    await tickFilterValues(user, "Platform", "France Travail");
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Location"));
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Frontend Developer")).not.toBeInTheDocument();
  });

  it("restores the platform filter and location search from the URL, and writes them back on change (issue #125)", async () => {
    const user = userEvent.setup();
    __setUrl("/analyses?platform=LINKEDIN&location=lyon");
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              jobOffer: {
                id: "j1",
                title: "Backend Engineer",
                company: "Acme",
                location: "Paris",
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
                location: "Lyon",
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
    expect(filterTrigger("Platform")).toHaveAccessibleName("Platform LinkedIn");
    expect(screen.getByLabelText("Location")).toHaveValue("lyon");

    await clearFilter(user, "Platform");
    await waitFor(() => {
      const url = new URL(__getUrl(), "http://localhost");
      expect(url.searchParams.has("platform")).toBe(false);
    });
  });

  it("keeps Search and Status above the table and folds the other filters behind a toggle", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(filterTrigger("Status")).toBeInTheDocument();
    for (const label of [
      "Requested from",
      "Requested to",
      "CV version",
      "Platform",
      "Location",
    ]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }

    const toggle = screen.getByRole("button", { name: "More filters" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    for (const label of [
      "Requested from",
      "Requested to",
      "CV version",
      "Platform",
      "Location",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }

    await user.click(toggle);
    expect(screen.queryByLabelText("Platform")).not.toBeInTheDocument();
  });

  it("opens the folded filters, and counts them on the toggle, when the URL already carries some", async () => {
    __setUrl("/analyses?platform=LINKEDIN&location=lyon");
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [summary()] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByLabelText("Search");

    expect(filterTrigger("Platform")).toHaveAccessibleName("Platform LinkedIn");
    expect(
      screen.getByRole("button", { name: "More filters (2)" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("clears the visible and the folded filters together (one 'Clear filters')", async () => {
    const user = userEvent.setup();
    __setUrl("/analyses?q=backend&platform=LINKEDIN");
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({
              id: "s1",
              jobOffer: { ...summary().jobOffer, id: "j1", title: "Backend Engineer" },
            }),
            summary({
              id: "s2",
              jobOffer: { ...summary().jobOffer, id: "j2", title: "Frontend Developer" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByLabelText("Search");
    expect(screen.queryByText("Frontend Developer")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("Frontend Developer")).toBeInTheDocument();
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByRole("button", { name: "More filters" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear filters" }),
    ).not.toBeInTheDocument();
    const url = new URL(__getUrl(), "http://localhost");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("platform")).toBe(false);
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
    expect(filterTrigger("Status")).toHaveAccessibleName("Status Rejected");
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
      http.get("/api/quotas", () =>
        HttpResponse.json({
          activeScouts: { cap: 20, used: 0, remaining: 20 },
          analysesDaily: { cap: 20, used: 0, remaining: 20 },
          analysesMonthly: { cap: 200, used: 0, remaining: 200 },
          documentsDaily: { cap: 20, used: 17, remaining: 3 },
        }),
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

  it("disables 'Run it again' when nothing selected is relaunchable, enabling it for a partial-eligible selection and naming the skipped count (issue #126)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", status: "COMPLETED", jobOffer: { ...summary().jobOffer, id: "j1", title: "Offer One" } }),
            summary({ id: "s2", status: "RUNNING_CREW", jobOffer: { ...summary().jobOffer, id: "j2", title: "Offer Two" } }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Offer One");

    await user.click(screen.getByRole("checkbox", { name: "Select Offer Two" }));
    expect(screen.getByRole("button", { name: "Run it again" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Select Offer One" }));
    expect(screen.getByRole("button", { name: "Run it again" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Run it again" }));

    expect(
      await screen.findByText("1 analysis will be re-run (1 skipped, still in progress) — 20 remaining today"),
    ).toBeInTheDocument();
  });

  it("disables the bulk relaunch confirm when the eligible selection would exceed the remaining analysis quota (issue #126)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", status: "COMPLETED", jobOffer: { ...summary().jobOffer, id: "j1", title: "Offer One" } }),
            summary({ id: "s2", status: "FAILED", jobOffer: { ...summary().jobOffer, id: "j2", title: "Offer Two" } }),
          ],
        }),
      ),
      http.get("/api/quotas", () =>
        HttpResponse.json({
          activeScouts: { cap: 20, used: 0, remaining: 20 },
          analysesDaily: { cap: 20, used: 19, remaining: 1 },
          analysesMonthly: { cap: 200, used: 0, remaining: 200 },
          documentsDaily: { cap: 20, used: 0, remaining: 20 },
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Offer One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(screen.getByRole("button", { name: "Run it again" }));

    expect(await screen.findByText("Re-run 2 analyses — 1 remaining today")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(
      screen.getByText("Not enough remaining quota today for this many analyses."),
    ).toBeInTheDocument();
  });

  it("bulk-relaunches the eligible selection via one POST /analyses per pair, refreshes the list, and reports a partial failure (issue #126)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", status: "COMPLETED", jobOffer: { ...summary().jobOffer, id: "j1", title: "Offer One" } }),
            summary({ id: "s2", status: "FAILED", jobOffer: { ...summary().jobOffer, id: "j2", title: "Offer Two" } }),
          ],
        }),
      ),
      http.post("/api/analyses", async ({ request }) => {
        const body = (await request.json()) as { jobOfferId: string; cvVersionId: string };
        if (body.jobOfferId === "j2") {
          return HttpResponse.json({ error: "Daily analysis limit reached" }, { status: 429 });
        }
        return HttpResponse.json({ analysisId: "new-1" }, { status: 202 });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Offer One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(screen.getByRole("button", { name: "Run it again" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 2");
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

    const fullAnalysisLink = quickView.getByRole("link", {
      name: "View full analysis",
    });
    const compareLink = quickView.getByRole("link", {
      name: "Compare with other CVs",
    });
    expect(fullAnalysisLink).toHaveAttribute("href", "/analyses/a1");
    expect(compareLink).toHaveAttribute("href", "/analyses/compare/job1");

    // Both lead the sheet now, in the same action row as "View job offer" —
    // ahead of the result breakdown rather than a scroll below it.
    expect(compareLink.parentElement).toBe(fullAnalysisLink.parentElement);
    expect(
      quickView.getByRole("link", { name: "View job offer" }).parentElement,
    ).toBe(fullAnalysisLink.parentElement);
    expect(
      fullAnalysisLink.compareDocumentPosition(
        quickView.getByText("Strong product engineer, light on platform work."),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

  it("closes the Quick view from its own labelled Fermer button, the bare corner X being gone", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [detail()] })),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("walks the filtered, sorted list from inside the Quick view without closing it, and disables each arrow at its end", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [OFFER_A, OFFER_B, OFFER_C] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Offer A"));

    const dialog = await screen.findByRole("dialog");
    const quickView = within(dialog);
    expect(quickView.getByRole("heading", { name: "Offer A" })).toBeInTheDocument();
    expect(quickView.getByText("1 / 3")).toBeInTheDocument();
    expect(quickView.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(quickView.getByRole("button", { name: "Next" }));
    expect(
      await quickView.findByRole("heading", { name: "Offer B" }),
    ).toBeInTheDocument();
    expect(quickView.getByText("2 / 3")).toBeInTheDocument();

    await user.click(quickView.getByRole("button", { name: "Next" }));
    expect(
      await quickView.findByRole("heading", { name: "Offer C" }),
    ).toBeInTheDocument();
    expect(quickView.getByText("3 / 3")).toBeInTheDocument();
    expect(quickView.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(quickView.getByRole("button", { name: "Previous" }));
    expect(
      await quickView.findByRole("heading", { name: "Offer B" }),
    ).toBeInTheDocument();
    // The whole point: never closed once between the two ends.
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("walks the list with the left and right arrow keys", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [OFFER_A, OFFER_B, OFFER_C] }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Offer A"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByRole("heading", { name: "Offer A" });

    await user.keyboard("{ArrowRight}");
    expect(
      await quickView.findByRole("heading", { name: "Offer B" }),
    ).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");
    expect(
      await quickView.findByRole("heading", { name: "Offer A" }),
    ).toBeInTheDocument();
  });

  it("flips the table to the next page when the arrows cross a page boundary, and hands focus back to the row actually shown", async () => {
    const user = userEvent.setup();
    const analyses = Array.from({ length: 30 }, (_, i) =>
      detail({
        id: `a${i}`,
        jobOffer: {
          id: `job${i}`,
          title: `Offer ${String(i).padStart(2, "0")}`,
          company: "Acme",
          location: "Paris",
          sourceSite: "OTHER",
          // Descending title order matches the default postedAt-desc sort, so
          // "Offer 29" is rank 1 and "Offer 00" is rank 30.
          postedAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          sourceUrl: `https://example.com/jobs/${i}`,
        },
      }),
    );
    server.use(http.get("/api/analyses", () => HttpResponse.json({ analyses })));

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Page 1 of 2");

    // "Offer 05" is rank 25 — the last row of page 1.
    await user.click(screen.getByText("Offer 05"));
    const quickView = within(await screen.findByRole("dialog"));
    expect(quickView.getByText("25 / 30")).toBeInTheDocument();

    await user.click(quickView.getByRole("button", { name: "Next" }));
    expect(
      await quickView.findByRole("heading", { name: "Offer 04" }),
    ).toBeInTheDocument();
    expect(quickView.getByText("26 / 30")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // Not the row that opened the panel — that one is on page 1 and unmounted.
    expect(document.activeElement).toBe(
      screen.getByText("Offer 04").closest("tr"),
    );
  });

  it("keeps showing an Analysis that a status change has just dropped out of the active filter, with an unknown rank", async () => {
    __setUrl("/analyses?status=TO_APPLY&sort=postedAt&dir=desc&page=1&pageSize=25");
    const user = userEvent.setup();
    let applicationStatus: string | null = null;
    const application = {
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
    };
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ applicationStatus }), OFFER_C] }),
      ),
      http.post("/api/applications", () => HttpResponse.json({ application })),
      http.post("/api/applications/app-1/status-events", () => {
        applicationStatus = "APPLIED";
        return HttpResponse.json({
          application: { ...application, status: "APPLIED" },
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
    expect(quickView.getByText("1 / 2")).toBeInTheDocument();

    await user.click(quickView.getByRole("button", { name: "In progress" }));

    // Still on screen, still the Analysis just acted on — only its rank is
    // gone, the "To apply" filter no longer holding it.
    await waitFor(() => expect(quickView.getByText("— / 1")).toBeInTheDocument());
    expect(
      quickView.getByRole("heading", { name: "Backend Engineer" }),
    ).toBeInTheDocument();

    // The slot it vacated now holds Offer C, which is what "next" reaches.
    await user.click(quickView.getByRole("button", { name: "Next" }));
    expect(
      await quickView.findByRole("heading", { name: "Offer C" }),
    ).toBeInTheDocument();
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
      pendingDocumentsPost(),
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

    // One slot at a time: asking for the cover letter leaves the tailored CV's
    // own button standing, which is the whole point of the split (adr/0031).
    await user.click(
      quickView.getByRole("button", { name: "Generate the cover letter" }),
    );
    expect(await quickView.findByText("Queued…")).toBeInTheDocument();
    expect(
      quickView.getByRole("button", { name: "Generate the tailored CV" }),
    ).toBeInTheDocument();

    await user.click(
      quickView.getByRole("button", { name: "Generate the tailored CV" }),
    );
    expect(await quickView.findAllByText("Queued…")).toHaveLength(2);
  });

  it("does not show \"Relancer l'analyse\" for a non-terminal analysis in the Quick view (issue #124)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [detail({ status: "RUNNING_CREW", resultJSON: null })],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByText("Running");
    expect(
      quickView.queryByRole("button", { name: "Run it again" }),
    ).not.toBeInTheDocument();
  });

  it("relaunches a COMPLETED analysis from the Quick view after confirmation, carrying the same offer/CV pair, and switches to the new one, for a non-external Role (issue #124)", async () => {
    const user = userEvent.setup();
    let analyses = [detail({ status: "COMPLETED" })];
    let createBody: unknown = null;
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses })),
      http.post("/api/analyses", async ({ request }) => {
        createBody = await request.json();
        analyses = [
          ...analyses,
          detail({
            id: "a2",
            status: "RUNNING_CREW",
            resultJSON: null,
            matchScore: null,
          }),
        ];
        return HttpResponse.json({ analysisId: "a2" });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: INTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));

    expect(
      quickView.getByText(/This will use one of your daily analyses/),
    ).toBeInTheDocument();
    expect(
      quickView.queryByLabelText("CV version"),
    ).not.toBeInTheDocument();

    await user.click(quickView.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(quickView.getByText("Running")).toBeInTheDocument(),
    );
    expect(createBody).toEqual({ jobOfferId: "job1", cvVersionId: "cv1" });
  });

  it("cancels the relaunch confirmation without calling the create-analysis request (issue #124)", async () => {
    const user = userEvent.setup();
    let createCalls = 0;
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ status: "COMPLETED" })] }),
      ),
      http.post("/api/analyses", () => {
        createCalls += 1;
        return HttpResponse.json({ analysisId: "a2" });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: INTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));
    await user.click(quickView.getByRole("button", { name: "Cancel" }));

    expect(
      quickView.queryByText(/This will use one of your daily analyses/),
    ).not.toBeInTheDocument();
    expect(quickView.getByRole("button", { name: "Run it again" })).toBeInTheDocument();
    expect(createCalls).toBe(0);
  });

  it("shows an inline error and stays on the original analysis when a Quick view relaunch fails, for a non-external Role (issue #124)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            detail({ status: "FAILED", resultJSON: null, errorMessage: "LLM timed out" }),
          ],
        }),
      ),
      http.post("/api/analyses", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: INTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));
    await user.click(quickView.getByRole("button", { name: "Confirm" }));

    expect(
      await quickView.findByText(
        "We couldn't start a new analysis. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(
      quickView.getByRole("heading", { name: "Backend Engineer" }),
    ).toBeInTheDocument();
  });

  it("preselects the Analysis's own CVVersion in the relaunch CV picker for an external candidate when it is still CONVERTED (issue #181)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ status: "COMPLETED", cvVersionId: "cv1" })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Grad CV" }),
            cvVersion({ id: "cv2", label: "Senior CV", isDefault: true }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: EXTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));

    const picker = (await quickView.findByLabelText(
      "CV version",
    )) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv1"));
  });

  it("falls back to the candidate's default CONVERTED CV in the relaunch picker when the Analysis's own CV was superseded (issue #181)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ status: "COMPLETED", cvVersionId: "cv1" })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Grad CV", supersededById: "cv3" }),
            cvVersion({ id: "cv2", label: "Senior CV", isDefault: true }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: EXTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));

    const picker = (await quickView.findByLabelText(
      "CV version",
    )) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv2"));
  });

  it("disables the relaunch confirm and shows the manage-CVs link for an external candidate with no CONVERTED CV (issue #181)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ status: "COMPLETED", cvVersionId: "cv1" })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ id: "cv1", conversionStatus: "FAILED" })],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: EXTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));

    await quickView.findByText(
      "None of your CV versions have been converted yet.",
    );
    expect(
      quickView.getByRole("link", { name: "Import a CV" }),
    ).toHaveAttribute("href", "/cv-versions");
    expect(quickView.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("relaunches with the CV chosen in the picker, and keeps that choice selected if the request fails, for an external candidate (issue #181)", async () => {
    const user = userEvent.setup();
    let createBody: unknown = null;
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [detail({ status: "COMPLETED", cvVersionId: "cv1" })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Grad CV" }),
            cvVersion({ id: "cv2", label: "Senior CV", isDefault: true }),
          ],
        }),
      ),
      http.post("/api/analyses", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />, { session: EXTERNAL_SESSION });
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Run it again" }));

    const picker = (await quickView.findByLabelText(
      "CV version",
    )) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv1"));
    await user.selectOptions(picker, "cv2");

    await user.click(quickView.getByRole("button", { name: "Confirm" }));

    expect(
      await quickView.findByText(
        "We couldn't start a new analysis. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(createBody).toEqual({ jobOfferId: "job1", cvVersionId: "cv2" });
    expect(picker.value).toBe("cv2");
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

  it("re-runs a FAILED analysis with one click and links to the new one, for a non-external Role (issue #183)", async () => {
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

    renderWithProviders(<AnalysisDetailPage />, { session: INTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    expect(screen.queryByLabelText("CV version")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm" }),
    ).not.toBeInTheDocument();

    const link = await screen.findByRole("link", {
      name: /a new analysis has started/i,
    });
    expect(link).toHaveAttribute("href", "/analyses/a2");
  });

  it("opens a confirm step with the quota warning instead of firing immediately, for an external candidate (issue #183)", async () => {
    const user = userEvent.setup();
    let createCalls = 0;
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({
            status: "FAILED",
            resultJSON: null,
            errorMessage: "LLM timed out",
            cvVersionId: "cv1",
          }),
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion({ id: "cv1" })] }),
      ),
      http.post("/api/analyses", () => {
        createCalls += 1;
        return HttpResponse.json({ analysisId: "a2" });
      }),
    );

    renderWithProviders(<AnalysisDetailPage />, { session: EXTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    expect(
      await screen.findByText(/This will use one of your daily analyses/),
    ).toBeInTheDocument();
    expect(createCalls).toBe(0);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByText(/This will use one of your daily analyses/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run it again" })).toBeInTheDocument();
    expect(createCalls).toBe(0);
  });

  it("preselects the Analysis's own CVVersion in the relaunch CV picker for an external candidate when it is still CONVERTED (issue #183)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({ status: "FAILED", resultJSON: null, cvVersionId: "cv1" }),
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Grad CV" }),
            cvVersion({ id: "cv2", label: "Senior CV", isDefault: true }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />, { session: EXTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    const picker = (await screen.findByLabelText("CV version")) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv1"));
  });

  it("falls back to the candidate's default CONVERTED CV in the relaunch picker when the Analysis's own CV was superseded (issue #183)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({ status: "FAILED", resultJSON: null, cvVersionId: "cv1" }),
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Grad CV", supersededById: "cv3" }),
            cvVersion({ id: "cv2", label: "Senior CV", isDefault: true }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />, { session: EXTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    const picker = (await screen.findByLabelText("CV version")) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv2"));
  });

  it("disables the relaunch confirm and shows the manage-CVs link for an external candidate with no CONVERTED CV (issue #183)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({ status: "FAILED", resultJSON: null, cvVersionId: "cv1" }),
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ id: "cv1", conversionStatus: "FAILED" })],
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />, { session: EXTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    await screen.findByText("None of your CV versions have been converted yet.");
    expect(screen.getByRole("link", { name: "Import a CV" })).toHaveAttribute(
      "href",
      "/cv-versions",
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("relaunches with the CV chosen in the picker, and keeps that choice selected if the request fails, for an external candidate (issue #183)", async () => {
    const user = userEvent.setup();
    let createBody: unknown = null;
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({ status: "FAILED", resultJSON: null, cvVersionId: "cv1" }),
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Grad CV" }),
            cvVersion({ id: "cv2", label: "Senior CV", isDefault: true }),
          ],
        }),
      ),
      http.post("/api/analyses", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );

    renderWithProviders(<AnalysisDetailPage />, { session: EXTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));

    const picker = (await screen.findByLabelText("CV version")) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv1"));
    await user.selectOptions(picker, "cv2");

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByText("We couldn't start a new analysis. Please try again."),
    ).toBeInTheDocument();
    expect(createBody).toEqual({ jobOfferId: "job1", cvVersionId: "cv2" });
    expect(picker.value).toBe("cv2");
  });

  it("relaunches with the confirmed CV for an external candidate and links to the new analysis on success (issue #183)", async () => {
    const user = userEvent.setup();
    let createBody: unknown = null;
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: detail({ status: "FAILED", resultJSON: null, cvVersionId: "cv1" }),
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion({ id: "cv1" })] }),
      ),
      http.post("/api/analyses", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ analysisId: "a2" });
      }),
    );

    renderWithProviders(<AnalysisDetailPage />, { session: EXTERNAL_SESSION });

    await user.click(await screen.findByRole("button", { name: "Run it again" }));
    const picker = (await screen.findByLabelText("CV version")) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("cv1"));

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    const link = await screen.findByRole("link", {
      name: /a new analysis has started/i,
    });
    expect(link).toHaveAttribute("href", "/analyses/a2");
    expect(createBody).toEqual({ jobOfferId: "job1", cvVersionId: "cv1" });
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
      pendingDocumentsPost(),
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

    await generateBothDocuments(user);

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
      pendingDocumentsPost(),
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

    await generateBothDocuments(user);
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
      pendingDocumentsPost(),
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

    await generateBothDocuments(user);
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
      pendingDocumentsPost(),
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

    await generateBothDocuments(user);
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
      pendingDocumentsPost(),
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

    await generateBothDocuments(user);
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

    // One slot's failure is reported in that slot, and leaves the other's
    // button untouched rather than failing the pair.
    await user.click(
      await screen.findByRole("button", { name: "Generate the cover letter" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't start generation. Please try again.",
    );
    expect(
      screen.getByRole("button", { name: "Generate the tailored CV" }),
    ).toBeEnabled();
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

  it("disables Apply while no generated document is ready", async () => {
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
      http.get("/api/analyses/a1/generated-documents", () =>
        HttpResponse.json({ generatedDocuments: PENDING_DOCUMENTS }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("enables Apply on the first ready document, the pair no longer being required (adr/0031)", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    server.use(
      http.get("/api/analyses/a1", () => HttpResponse.json({ analysis: detail() })),
      // A candidate who deliberately asked for a cover letter alone: the
      // tailored CV was never requested, so waiting for it would grey Apply
      // out forever.
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
            status: "APPLIED",
            appliedAt: "2026-09-11T00:00:00.000Z",
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
            cvVersion: { label: "Grad CV" },
          },
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    const applyButton = await screen.findByRole("button", { name: "Apply" });
    await waitFor(() => expect(applyButton).toBeEnabled());

    await user.click(applyButton);

    // The posting, then the one document that exists — not a failed attempt
    // at the missing one.
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
    expect(openSpy).toHaveBeenCalledTimes(2);

    openSpy.mockRestore();
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

// A worker or ElasticMQ restart orphans a non-terminal Analysis: the queued
// message is gone, the row stays "Pending" forever and nothing is coming for it.
// The server derives `stuck` (docs/adr/0032) and these cover the one repair the
// UI offers — re-drive the same row, no new Analysis and no quota.
describe("a stuck analysis", () => {
  const STUCK_NOTE =
    "This analysis looks interrupted: nothing has advanced it for a while, most likely because the service restarted.";

  function stuckDetail(overrides: Record<string, unknown> = {}) {
    return detail({
      status: "PENDING",
      stuck: true,
      matchScore: null,
      resultJSON: null,
      ...overrides,
    });
  }

  it("offers a requeue on the detail page and posts to the requeue endpoint", async () => {
    const user = userEvent.setup();
    let requeued = 0;
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: stuckDetail() }),
      ),
      http.post("/api/analyses/a1/requeue", () => {
        requeued += 1;
        return HttpResponse.json({ status: "PENDING" }, { status: 202 });
      }),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText(STUCK_NOTE)).toBeInTheDocument();
    expect(
      screen.getByText("It picks up where it left off, and costs you no quota."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run it again" }));

    await waitFor(() => expect(requeued).toBe(1));
    expect(
      await screen.findByText(
        "The analysis is back in the queue — this page updates on its own.",
      ),
    ).toBeInTheDocument();
  });

  it("does not also claim the analysis is still running", async () => {
    // Both messages are true of a non-terminal row, and showing them together
    // would contradict itself: "it updates on its own" next to "it is stuck".
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: stuckDetail() }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(await screen.findByText(STUCK_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByText(
        "This analysis is still running — this page updates itself.",
      ),
    ).not.toBeInTheDocument();
  });

  it("reports a 409 as 'still being processed' rather than a generic failure", async () => {
    // The client offers the button from the server's own flag, but the server
    // re-checks on the way in: between the read and the click the worker may
    // have picked the row up after all.
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: stuckDetail() }),
      ),
      http.post("/api/analyses/a1/requeue", () =>
        HttpResponse.json(
          { detail: { code: "ANALYSIS_NOT_STUCK", message: "still processing" } },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);
    await screen.findByText(STUCK_NOTE);

    await user.click(screen.getByRole("button", { name: "Run it again" }));

    expect(
      await screen.findByText(
        "This analysis is in fact still being processed. Let it finish.",
      ),
    ).toBeInTheDocument();
  });

  it("reports any other failure as a retryable error", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({ analysis: stuckDetail() }),
      ),
      http.post("/api/analyses/a1/requeue", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);
    await screen.findByText(STUCK_NOTE);

    await user.click(screen.getByRole("button", { name: "Run it again" }));

    expect(
      await screen.findByText(
        "We couldn't restart this analysis. Please try again.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves a healthy non-terminal analysis alone", async () => {
    server.use(
      http.get("/api/analyses/a1", () =>
        HttpResponse.json({
          analysis: stuckDetail({ stuck: false }),
        }),
      ),
    );

    renderWithProviders(<AnalysisDetailPage />);

    expect(
      await screen.findByText(
        "This analysis is still running — this page updates itself.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(STUCK_NOTE)).not.toBeInTheDocument();
  });

  it("offers the requeue from the Quick view too", async () => {
    const user = userEvent.setup();
    let requeued = 0;
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            stuckDetail({ jobOffer: { ...summary().jobOffer, title: "Stuck Offer" } }),
          ],
        }),
      ),
      http.post("/api/analyses/a1/requeue", () => {
        requeued += 1;
        return HttpResponse.json({ status: "PENDING" }, { status: 202 });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    await user.click(await screen.findByText("Stuck Offer"));

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(STUCK_NOTE)).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Run it again" }));

    await waitFor(() => expect(requeued).toBe(1));
  });

  it("bulk-requeues only the stuck rows of the selection, via one POST per row", async () => {
    // The incident behind docs/adr/0032 stranded 22 rows at once, and the only
    // repair was one Quick view at a time. The stuck subset is the server's
    // verdict, so a selected healthy row is left out rather than sent and
    // refused.
    const user = userEvent.setup();
    const requeued: string[] = [];
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", status: "PENDING", stuck: true, jobOffer: { ...summary().jobOffer, title: "Stranded One" } }),
            summary({ id: "s2", status: "PENDING", stuck: true, jobOffer: { ...summary().jobOffer, title: "Stranded Two" } }),
            summary({ id: "s3", status: "PENDING", stuck: false, jobOffer: { ...summary().jobOffer, title: "Still Queued" } }),
          ],
        }),
      ),
      http.post("/api/analyses/:id/requeue", ({ params }) => {
        requeued.push(params.id as string);
        return HttpResponse.json({ status: "PENDING" }, { status: 202 });
      }),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Stranded One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(
      await screen.findByRole("button", { name: "Pick up 2 interrupted analyses" }),
    );

    await waitFor(() => expect(requeued.sort()).toEqual(["s1", "s2"]));
  });

  it("offers no bulk requeue when nothing in the selection is stuck", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [summary({ id: "s1", status: "COMPLETED", stuck: false })],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByLabelText("Select all on this page"));

    expect(
      screen.queryByRole("button", { name: /Pick up/ }),
    ).not.toBeInTheDocument();
  });

  it("reports how many of a bulk requeue the server refused as still running", async () => {
    // A 409 here means the row was alive after all — the plain age check
    // (docs/adr/0032) can flag a row still queued behind a Scout fan-out, and
    // the server is the authority.
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            summary({ id: "s1", status: "PENDING", stuck: true, jobOffer: { ...summary().jobOffer, title: "Stranded One" } }),
            summary({ id: "s2", status: "PENDING", stuck: true, jobOffer: { ...summary().jobOffer, title: "Stranded Two" } }),
          ],
        }),
      ),
      http.post("/api/analyses/:id/requeue", ({ params }) =>
        params.id === "s2"
          ? HttpResponse.json(
              { detail: { code: "ANALYSIS_NOT_STUCK" } },
              { status: 409 },
            )
          : HttpResponse.json({ status: "PENDING" }, { status: 202 }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);
    await screen.findByText("Stranded One");

    await user.click(screen.getByLabelText("Select all on this page"));
    await user.click(
      await screen.findByRole("button", { name: "Pick up 2 interrupted analyses" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 2");
  });

  it("shows a failed analysis's reason in the Quick view, next to its relaunch", async () => {
    // The reason was only ever rendered on the full detail page, so the Quick
    // view offered a relaunch with no explanation of what went wrong.
    const user = userEvent.setup();
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            detail({
              status: "FAILED",
              matchScore: null,
              resultJSON: null,
              errorMessage: "ExtractionError: the offer page had no description",
              jobOffer: { ...summary().jobOffer, title: "Failed Offer" },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<AnalysesDashboardPage />);

    await user.click(await screen.findByText("Failed Offer"));

    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("ExtractionError: the offer page had no description"),
    ).toBeInTheDocument();
  });
});
