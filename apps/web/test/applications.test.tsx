import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import { __getUrl, __setUrl } from "./next-navigation-mock";
import ApplicationsPage from "@/app/(app)/applications/page";
import ApplicationDetailPage from "@/app/(app)/applications/[id]/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return { ...mock, useParams: () => ({ id: "app-1" }) };
});

function application(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

const BACKEND = application();
const FRONTEND = application({
  id: "app-2",
  analysisId: "a2",
  jobOfferId: "job2",
  scoutId: "scout-1",
  status: "APPLIED",
  appliedAt: "2026-09-20T10:00:00.000Z",
  jobOffer: {
    id: "job2",
    title: "Frontend Engineer",
    company: "Globex",
    location: "Lyon",
    sourceSite: "LINKEDIN",
    sourceUrl: "https://example.com/jobs/job2",
  },
});
const DATA = application({
  id: "app-3",
  analysisId: "a3",
  jobOfferId: "job3",
  status: "REJECTED",
  appliedAt: "2026-09-10T10:00:00.000Z",
  jobOffer: { id: "job3", title: "Data Engineer", company: "Initech" },
});

function listApplications(applications: unknown[]) {
  return http.get("/api/applications", () => HttpResponse.json({ applications }));
}

/** The table's body rows, in rendered order — the header row excluded. */
function bodyRows() {
  return within(screen.getAllByRole("rowgroup")[1]!).getAllByRole("row");
}

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
    await user.click(await screen.findByRole("menuitemcheckbox", { name: value }));
  }
  await user.keyboard("{Escape}");
}

describe("ApplicationsPage — table (#236)", () => {
  beforeEach(() => {
    __setUrl("/applications");
  });

  afterEach(() => {
    __setUrl("/applications");
  });

  it("renders a table row per Application with its title, company and Tracking status", async () => {
    server.use(listApplications([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    // Newest application first; a never-applied row sorts last.
    expect(within(rows[0]!).getByText("Frontend Engineer")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Globex")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("In progress")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Acme Inc")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("To apply")).toBeInTheDocument();
  });

  it("links the offer out to its source, leaving the title to open the quick view", async () => {
    server.use(listApplications([FRONTEND]));

    renderWithProviders(<ApplicationsPage />);

    await screen.findByText("Frontend Engineer");
    expect(screen.queryByRole("link", { name: "Frontend Engineer" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the job offer" })).toHaveAttribute(
      "href",
      "https://example.com/jobs/job2",
    );
  });

  it("shows the '—' placeholder when the offer has no company", async () => {
    server.use(
      listApplications([
        application({ jobOffer: { id: "job1", title: "Backend Engineer", company: null } }),
      ]),
    );

    renderWithProviders(<ApplicationsPage />);

    await screen.findByText("Backend Engineer");
    const [row] = bodyRows();
    expect(within(row!).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows an empty state when there are no Applications", async () => {
    server.use(listApplications([]));

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("No applications tracked yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("hides the score column by default and shows the application date", async () => {
    server.use(listApplications([FRONTEND]));

    renderWithProviders(<ApplicationsPage />);

    await screen.findByText("Frontend Engineer");
    expect(screen.queryByRole("columnheader", { name: /Score/ })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Applied/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Company/ })).toBeInTheDocument();
  });

  it("toggles a column from the Columns menu and remembers it under column-visibility:applications", async () => {
    const user = userEvent.setup();
    server.use(listApplications([FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Score" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Company" }));
    await user.keyboard("{Escape}");

    expect(screen.getByRole("columnheader", { name: /Score/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Company/ })).not.toBeInTheDocument();
    const stored = JSON.parse(
      window.localStorage.getItem("column-visibility:applications") ?? "{}",
    ) as Record<string, boolean>;
    expect(stored.matchScore).toBe(true);
    expect(stored.company).toBe(false);
  });

  it("sorts by application date, oldest first on a click, and writes sortDir to the URL", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND, DATA]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");
    expect(__getUrl()).toBe("/applications");

    await user.click(screen.getByRole("button", { name: /Applied/ }));

    expect(__getUrl()).toContain("sortDir=asc");
    const rows = bodyRows();
    expect(within(rows[0]!).getByText("Data Engineer")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Frontend Engineer")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Backend Engineer")).toBeInTheDocument();
  });

  it("narrows the rows by search and writes q to the URL", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");

    await user.type(screen.getByLabelText("Search"), "globex");

    expect(__getUrl()).toContain("q=globex");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByText("Frontend Engineer")).toBeInTheDocument();
  });

  it("filters by several Tracking statuses at once and writes them to the URL", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND, DATA]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");

    await tickFilterValues(user, "Status", "In progress", "Rejected");

    const url = new URL(__getUrl(), "http://localhost");
    expect(url.searchParams.get("status")).toBe("IN_PROGRESS,REJECTED");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByText("Frontend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Data Engineer")).toBeInTheDocument();
  });

  it("says so when no Application matches the filters", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");

    await user.type(screen.getByLabelText("Search"), "nothing like it");

    expect(screen.getByText("No applications match your filters.")).toBeInTheDocument();
  });

  it("folds the advanced filters behind 'More filters', counting the active ones on the toggle", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");

    const toggle = screen.getByRole("button", { name: "More filters" });
    expect(screen.queryByLabelText("Location")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Applied from")).toBeInTheDocument();
    expect(screen.getByLabelText("Applied to")).toBeInTheDocument();
    expect(screen.getByLabelText("Scout")).toBeInTheDocument();
    expect(filterTrigger("Platform")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Location"), "lyon");
    expect(__getUrl()).toContain("location=lyon");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More filters (1)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More filters (1)" }));
    expect(screen.queryByLabelText("Location")).not.toBeInTheDocument();
  });

  it("opens the panel already expanded when the URL carries an advanced filter", async () => {
    __setUrl("/applications?scoutId=scout-1&sourceSite=LINKEDIN");
    server.use(
      listApplications([BACKEND, FRONTEND]),
      http.get("/api/scouts", () =>
        HttpResponse.json({ scouts: [{ id: "scout-1", label: "Paris backend" }] }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("Frontend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More filters (2)" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("resets every filter, visible and folded, with one 'Clear filters'", async () => {
    const user = userEvent.setup();
    __setUrl("/applications?q=engineer&status=IN_PROGRESS&location=lyon");
    server.use(listApplications([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(__getUrl()).toBe("/applications");
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("replaces the table with a card per Application below ~640px", async () => {
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
      server.use(listApplications([FRONTEND]));

      renderWithProviders(<ApplicationsPage />);

      const title = await screen.findByText("Frontend Engineer");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      const card = within(title.closest("[data-application-id]") as HTMLElement);
      expect(card.getByText("Globex", { exact: false })).toBeInTheDocument();
      expect(card.getByText("In progress")).toBeInTheDocument();
      expect(card.getByRole("link", { name: "Open the job offer" })).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe("ApplicationsPage — bulk actions (#238)", () => {
  beforeEach(() => {
    __setUrl("/applications");
  });

  afterEach(() => {
    __setUrl("/applications");
  });

  it("shows the bulk-actions bar only while something is selected, offering Tracking status changes and CSV export", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");

    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    for (const name of ["In progress", "Rejected", "Accepted", "Withdrawn"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "To apply" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("bulk-changes the Tracking status of the selected Applications and reports a partial failure", async () => {
    const user = userEvent.setup();
    const statusEvents: { applicationId: string; status: string }[] = [];
    server.use(
      listApplications([BACKEND, FRONTEND, DATA]),
      http.post("/api/applications", async ({ request }) => {
        const { analysisId } = (await request.json()) as { analysisId: string };
        if (analysisId === "a3") {
          return HttpResponse.json({ error: "boom" }, { status: 500 });
        }
        const existing = [BACKEND, FRONTEND].find((a) => a.analysisId === analysisId)!;
        return HttpResponse.json({ application: existing });
      }),
      http.post("/api/applications/:id/status-events", async ({ params, request }) => {
        const { status } = (await request.json()) as { status: string };
        statusEvents.push({ applicationId: String(params.id), status });
        return HttpResponse.json({ application: BACKEND, statusEvent: {} });
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Frontend Engineer" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Data Engineer" }));
    await user.click(screen.getByRole("button", { name: "Rejected" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 3");
    expect(statusEvents).toHaveLength(2);
    expect(statusEvents.map((e) => e.applicationId).sort()).toEqual(["app-1", "app-2"]);
    expect(statusEvents.every((e) => e.status === "REJECTED")).toBe(true);
  });

  it("extends the selection from the page to every Application matching the filters", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 27 }, (_, i) =>
      application({
        id: `app-${i}`,
        analysisId: `a-${i}`,
        appliedAt: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        status: "APPLIED",
        jobOffer: { id: `job-${i}`, title: `Offer ${i}`, company: "Acme Inc" },
      }),
    );
    // Drops out of the filtered result: never counted by "select all matching".
    const rejected = application({
      id: "app-rejected",
      analysisId: "a-rejected",
      status: "REJECTED",
      jobOffer: { id: "job-r", title: "Rejected Offer", company: "Acme Inc" },
    });
    __setUrl("/applications?status=IN_PROGRESS");
    server.use(listApplications([...many, rejected]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Offer 26");

    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    expect(screen.getByText("25 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select all 27 matching your filters" }));

    expect(screen.getByText("27 selected")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Select all \d+ matching your filters/ }),
    ).not.toBeInTheDocument();
  });

  it("exports only the selected rows to CSV without a network request", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND]));

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

    try {
      renderWithProviders(<ApplicationsPage />);
      await screen.findByText("Frontend Engineer");

      await user.click(screen.getByRole("checkbox", { name: "Select Frontend Engineer" }));
      await user.click(screen.getByRole("button", { name: "Export CSV" }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const text = await createObjectURL.mock.calls[0]![0].text();
      expect(text).toContain("Frontend Engineer");
      expect(text).toContain("Globex");
      expect(text).not.toContain("Backend Engineer");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);
    } finally {
      clickSpy.mockRestore();
      // @ts-expect-error -- jsdom has no implementation to restore to.
      delete URL.createObjectURL;
      // @ts-expect-error -- jsdom has no implementation to restore to.
      delete URL.revokeObjectURL;
    }
  });
});

/** GET /applications/:id for the quick view: the list row plus a timeline. */
function applicationDetails(
  applications: { id: string; status: string; jobOffer: Record<string, unknown> }[],
) {
  return http.get("/api/applications/:id", ({ params }) => {
    const found = applications.find((a) => a.id === params.id);
    if (!found) return HttpResponse.json({ error: "not found" }, { status: 404 });
    return HttpResponse.json({
      application: {
        ...found,
        jobOffer: { sourceUrl: "https://example.com/jobs/x", ...found.jobOffer },
        statusEvents: [
          {
            id: `se-${found.id}`,
            applicationId: found.id,
            status: found.status,
            note: `Moved ${found.id}`,
            effectiveDate: "2026-09-20T00:00:00.000Z",
            createdAt: "2026-09-20T00:00:00.000Z",
          },
        ],
      },
    });
  });
}

/** GET /analyses/:id for the quick view's analysis recall (#242); unknown ids 404. */
function analysisDetails(analyses: Record<string, Record<string, unknown>>) {
  return http.get("/api/analyses/:id", ({ params }) => {
    const found = analyses[params.id as string];
    if (!found) return HttpResponse.json({ error: "not found" }, { status: 404 });
    return HttpResponse.json({ analysis: { id: params.id, ...found } });
  });
}

describe("ApplicationsPage — quick view (#237)", () => {
  beforeEach(() => {
    __setUrl("/applications");
    server.use(analysisDetails({}));
  });

  afterEach(() => {
    __setUrl("/applications");
  });

  it("opens the Application quick view on a row click, showing its title, Tracking status and timeline", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND, FRONTEND]), applicationDetails([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Frontend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(quickView.getByRole("heading", { name: "Frontend Engineer" })).toBeInTheDocument();
    expect(quickView.getByText("In progress")).toBeInTheDocument();
    expect(quickView.getByText("Globex · Lyon")).toBeInTheDocument();
    expect(await quickView.findByText("Moved app-2")).toBeInTheDocument();
    // No evaluation or pipeline actions on this panel.
    expect(quickView.queryByRole("button", { name: /relaunch|requeue|generate/i })).toBeNull();
  });

  it("does not open the quick view when the row's checkbox is ticked", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND]), applicationDetails([BACKEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");
    await user.click(screen.getByRole("checkbox", { name: "Select Backend Engineer" }));

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("changes the Tracking status from the panel by appending a StatusEvent to that Application", async () => {
    const user = userEvent.setup();
    const statusEvents: { applicationId: string; status: string }[] = [];
    let rejected = false;
    server.use(
      http.get("/api/applications", () =>
        HttpResponse.json({
          applications: [rejected ? { ...FRONTEND, status: "REJECTED" } : FRONTEND],
        }),
      ),
      applicationDetails([FRONTEND]),
      http.post("/api/applications/:id/status-events", async ({ params, request }) => {
        const { status } = (await request.json()) as { status: string };
        statusEvents.push({ applicationId: String(params.id), status });
        rejected = true;
        return HttpResponse.json({ application: { ...FRONTEND, status }, statusEvent: {} });
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Frontend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(quickView.queryByRole("button", { name: "In progress" })).not.toBeInTheDocument();
    await user.click(quickView.getByRole("button", { name: "Rejected" }));

    await waitFor(() =>
      expect(statusEvents).toEqual([{ applicationId: "app-2", status: "REJECTED" }]),
    );
    // The table row follows without a reload (queried by attribute: the
    // open Sheet hides the table from the accessibility tree).
    await waitFor(() =>
      expect(
        within(
          document.querySelector<HTMLElement>('tr[data-application-id="app-2"]')!,
        ).getByText("Rejected"),
      ).toBeInTheDocument(),
    );
  });

  it("links back to the Analysis and the Scout, and to generated documents when they exist", async () => {
    const user = userEvent.setup();
    const withDocs = { ...FRONTEND, coverLetterDocId: "doc-cl", tailoredCvDocId: null };
    server.use(listApplications([withDocs]), applicationDetails([withDocs]));

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Frontend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(quickView.getByRole("link", { name: "View the analysis" })).toHaveAttribute(
      "href",
      "/analyses/a2",
    );
    expect(quickView.getByRole("link", { name: "View the Scout" })).toHaveAttribute(
      "href",
      "/scouts?open=scout-1",
    );
    expect(quickView.getByRole("link", { name: "Cover letter" })).toHaveAttribute(
      "href",
      "/api/generated-documents/doc-cl/download?format=pdf",
    );
    expect(quickView.queryByRole("link", { name: "Tailored CV" })).not.toBeInTheDocument();
  });

  it("hides 'View the Scout' when the Application has no Scout", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND]), applicationDetails([BACKEND]));

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(quickView.getByRole("link", { name: "View the analysis" })).toBeInTheDocument();
    expect(quickView.queryByRole("link", { name: "View the Scout" })).not.toBeInTheDocument();
  });

  it("steps through the filtered, sorted list with Previous / Next, disabled at each end", async () => {
    const user = userEvent.setup();
    server.use(
      listApplications([BACKEND, FRONTEND, DATA]),
      applicationDetails([BACKEND, FRONTEND, DATA]),
    );

    renderWithProviders(<ApplicationsPage />);
    // Sorted newest application first: Frontend, Data, then never-applied Backend.
    await user.click(await screen.findByText("Frontend Engineer"));

    const dialog = await screen.findByRole("dialog");
    const quickView = within(dialog);
    expect(quickView.getByText("1 / 3")).toBeInTheDocument();
    expect(quickView.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(quickView.getByRole("button", { name: "Next" }));
    expect(await quickView.findByRole("heading", { name: "Data Engineer" })).toBeInTheDocument();
    expect(quickView.getByText("2 / 3")).toBeInTheDocument();

    await user.click(quickView.getByRole("button", { name: "Next" }));
    expect(await quickView.findByRole("heading", { name: "Backend Engineer" })).toBeInTheDocument();
    expect(quickView.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(quickView.getByRole("button", { name: "Previous" }));
    expect(await quickView.findByRole("heading", { name: "Data Engineer" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("steps with the left and right arrow keys", async () => {
    const user = userEvent.setup();
    server.use(
      listApplications([BACKEND, FRONTEND, DATA]),
      applicationDetails([BACKEND, FRONTEND, DATA]),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Frontend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByRole("heading", { name: "Frontend Engineer" });

    await user.keyboard("{ArrowRight}");
    expect(await quickView.findByRole("heading", { name: "Data Engineer" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(await quickView.findByRole("heading", { name: "Frontend Engineer" })).toBeInTheDocument();
  });

  it("flips the table page when Next crosses a page boundary", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 26 }, (_, i) =>
      application({
        id: `app-p${i}`,
        analysisId: `ap${i}`,
        appliedAt: new Date(Date.UTC(2026, 8, 1) + (26 - i) * 86_400_000).toISOString(),
        jobOffer: { id: `jp${i}`, title: `Role ${i}`, company: "Acme" },
      }),
    );
    server.use(listApplications(many), applicationDetails(many));

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Role 24"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Next" }));

    expect(await quickView.findByRole("heading", { name: "Role 25" })).toBeInTheDocument();
    await waitFor(() => expect(__getUrl()).toContain("page=2"));
  });

  /** The value the panel shows next to a field label (a `<dt>` / `<dd>` pair). */
  function panelField(quickView: ReturnType<typeof within>, label: string) {
    return quickView.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
  }

  it("shows the date of application, CV used, platform, location, offer link and Scout (#241)", async () => {
    const user = userEvent.setup();
    server.use(listApplications([FRONTEND]), applicationDetails([FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Frontend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(panelField(quickView, "Applied on")).toBe(
      new Date("2026-09-20T10:00:00.000Z").toLocaleDateString(),
    );
    expect(panelField(quickView, "CV used")).toBe("Grad CV");
    expect(panelField(quickView, "Platform")).toBe("LinkedIn");
    expect(panelField(quickView, "Location")).toBe("Lyon");
    expect(quickView.getByRole("link", { name: "View job offer" })).toHaveAttribute(
      "href",
      "https://example.com/jobs/job2",
    );
    expect(quickView.getByRole("link", { name: "View the Scout" })).toHaveAttribute(
      "href",
      "/scouts?open=scout-1",
    );
  });

  it("fills the offer's platform, location and link from the Application when the list row lacks them (#241)", async () => {
    const user = userEvent.setup();
    const listRow = application({ appliedAt: "2026-09-20T10:00:00.000Z" });
    server.use(
      listApplications([listRow]),
      applicationDetails([
        {
          ...listRow,
          jobOffer: {
            ...listRow.jobOffer,
            location: "Paris",
            sourceSite: "INDEED",
            sourceUrl: "https://example.com/jobs/job1",
          },
        },
      ]),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await waitFor(() => expect(panelField(quickView, "Platform")).toBe("Indeed"));
    expect(panelField(quickView, "Location")).toBe("Paris");
    expect(quickView.getByRole("link", { name: "View job offer" })).toHaveAttribute(
      "href",
      "https://example.com/jobs/job1",
    );
  });

  it("shows '—' for each missing piece of information and no Scout link (#241)", async () => {
    const user = userEvent.setup();
    const bare = application({ jobOffer: { id: "job1", title: "Backend Engineer", company: null } });
    server.use(
      listApplications([bare]),
      applicationDetails([{ ...bare, jobOffer: { ...bare.jobOffer, sourceSite: null } }]),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByText("Moved app-1");
    expect(panelField(quickView, "Applied on")).toBe("—");
    expect(panelField(quickView, "Platform")).toBe("—");
    expect(panelField(quickView, "Location")).toBe("—");
    expect(panelField(quickView, "Company")).toBe("—");
    expect(quickView.queryByRole("link", { name: "View the Scout" })).not.toBeInTheDocument();
  });

  it("shows every StatusEvent, newest first, and no 'View full history' link (#241)", async () => {
    const user = userEvent.setup();
    const events = ["DRAFT", "APPLIED", "INTERVIEWING", "OFFER", "ACCEPTED"].map((status, i) => ({
      id: `se-${i}`,
      applicationId: "app-1",
      status,
      note: `Event ${i}`,
      effectiveDate: `2026-09-1${i}T00:00:00.000Z`,
      createdAt: `2026-09-1${i}T00:00:00.000Z`,
    }));
    server.use(
      listApplications([BACKEND]),
      http.get("/api/applications/:id", () =>
        HttpResponse.json({
          application: {
            ...BACKEND,
            jobOffer: { ...BACKEND.jobOffer, sourceUrl: "https://example.com/jobs/job1" },
            statusEvents: events,
          },
        }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByText("Event 0");
    const notes = quickView.getAllByText(/^Event \d$/).map((note) => note.textContent);
    expect(notes).toEqual(["Event 4", "Event 3", "Event 2", "Event 1", "Event 0"]);
    expect(quickView.queryByRole("link", { name: "View full history" })).not.toBeInTheDocument();
  });

  it("recalls the analysis summary and match score for a completed analysis (#242)", async () => {
    const user = userEvent.setup();
    server.use(
      listApplications([FRONTEND]),
      applicationDetails([FRONTEND]),
      analysisDetails({
        a2: {
          status: "COMPLETED",
          matchScore: 82,
          resultJSON: { match_score: 82, summary: "Strong React fit, light on Go." },
        },
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Frontend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(await quickView.findByText("Strong React fit, light on Go.")).toBeInTheDocument();
    expect(quickView.getByRole("img", { name: "Match score 82 out of 100" })).toBeInTheDocument();
    expect(quickView.getByRole("heading", { name: "Analysis" })).toBeInTheDocument();
    expect(quickView.getByRole("link", { name: "View the analysis" })).toHaveAttribute(
      "href",
      "/analyses/a2",
    );
  });

  it.each([
    ["not completed", { status: "RUNNING_CREW", matchScore: null, resultJSON: null }],
    [
      "completed without a summary",
      { status: "COMPLETED", matchScore: 60, resultJSON: { match_score: 60, summary: "" } },
    ],
  ])("hides the analysis recall when the analysis is %s (#242)", async (_case, analysis) => {
    const user = userEvent.setup();
    let fetched = false;
    server.use(
      listApplications([BACKEND]),
      applicationDetails([BACKEND]),
      http.get("/api/analyses/:id", () => {
        fetched = true;
        return HttpResponse.json({ analysis: { id: "a1", ...analysis } });
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await quickView.findByText("Moved app-1");
    await waitFor(() => expect(fetched).toBe(true));
    expect(quickView.queryByRole("heading", { name: "Analysis" })).not.toBeInTheDocument();
    expect(quickView.queryByRole("img", { name: /Match score/ })).not.toBeInTheDocument();
  });

  it("keeps the rest of the panel usable when the analysis fails to load (#242)", async () => {
    const user = userEvent.setup();
    let posted: string | null = null;
    server.use(
      listApplications([BACKEND]),
      applicationDetails([BACKEND]),
      http.get("/api/analyses/:id", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
      http.post("/api/applications/:id/status-events", async ({ request }) => {
        posted = ((await request.json()) as { status: string }).status;
        return HttpResponse.json({ statusEvent: { id: "se-new" } }, { status: 201 });
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    expect(await quickView.findByText("Moved app-1")).toBeInTheDocument();
    expect(quickView.queryByRole("heading", { name: "Analysis" })).not.toBeInTheDocument();
    await user.click(quickView.getByRole("button", { name: "Rejected" }));
    await waitFor(() => expect(posted).toBe("REJECTED"));
  });

  it("only loads the analysis once the panel is opened, for that Application (#242)", async () => {
    const user = userEvent.setup();
    const requested: string[] = [];
    server.use(
      listApplications([BACKEND, FRONTEND]),
      applicationDetails([BACKEND, FRONTEND]),
      http.get("/api/analyses/:id", ({ params }) => {
        requested.push(params.id as string);
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Frontend Engineer");
    expect(requested).toEqual([]);

    await user.click(screen.getByText("Frontend Engineer"));
    await waitFor(() => expect(requested).toEqual(["a2"]));
  });

  it("closes with the Close button", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND]), applicationDetails([BACKEND]));

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByText("Backend Engineer"));

    const quickView = within(await screen.findByRole("dialog"));
    await user.click(quickView.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("ApplicationsPage — stats modal (#236)", () => {
  function statsWindow(overrides: Record<string, unknown> = {}) {
    return {
      offersDiscovered: 0,
      relevantFinds: 0,
      documentsGenerated: 0,
      applicationsSubmitted: 0,
      responseRate: 0,
      interviewRate: 0,
      offerRate: 0,
      acceptanceRate: 0,
      medianDaysToFirstResponse: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    __setUrl("/applications");
  });

  it("keeps the stats out of the page until 'Statistics' opens them in a modal", async () => {
    const user = userEvent.setup();
    server.use(listApplications([BACKEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");

    expect(screen.queryByText("Applications submitted")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Statistics" }));

    const dialog = await screen.findByRole("dialog", { name: "Statistics" });
    expect(within(dialog).getByText("Applications submitted")).toBeInTheDocument();
  });

  it("shows all-time metrics by default and switches to the last-30-days window", async () => {
    const user = userEvent.setup();
    server.use(
      listApplications([]),
      http.get("/api/applications/stats", () =>
        HttpResponse.json({
          allTime: statsWindow({ applicationsSubmitted: 12, responseRate: 50 }),
          last30Days: statsWindow({ applicationsSubmitted: 3, responseRate: 33.3 }),
        }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByRole("button", { name: "Statistics" }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("12")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Last 30 days" }));

    expect(await within(dialog).findByText("3")).toBeInTheDocument();
  });

  it("is zero-safe with no data", async () => {
    const user = userEvent.setup();
    server.use(
      listApplications([]),
      http.get("/api/applications/stats", () =>
        HttpResponse.json({ allTime: statsWindow(), last30Days: statsWindow() }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);
    await user.click(await screen.findByRole("button", { name: "Statistics" }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Applications submitted")).toBeInTheDocument();
    expect(within(dialog).getByText("—")).toBeInTheDocument();
  });

  it("closes without touching the table's state", async () => {
    const user = userEvent.setup();
    __setUrl("/applications?q=backend");
    server.use(listApplications([BACKEND, FRONTEND]));

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");

    await user.click(screen.getByRole("button", { name: "Statistics" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(__getUrl()).toBe("/applications?q=backend");
    expect(screen.queryByText("Frontend Engineer")).not.toBeInTheDocument();
  });
});

describe("ApplicationDetailPage", () => {
  it("renders the offer, current status, and status timeline with back-links", async () => {
    server.use(
      http.get("/api/applications/app-1", () =>
        HttpResponse.json({
          application: {
            ...application({ status: "APPLIED", scoutId: "scout-1" }),
            statusEvents: [
              {
                id: "se-1",
                applicationId: "app-1",
                status: "APPLIED",
                note: "Applied via site",
                effectiveDate: "2026-09-11T00:00:00.000Z",
                createdAt: "2026-09-11T00:00:00.000Z",
              },
            ],
          },
        }),
      ),
    );

    renderWithProviders(<ApplicationDetailPage />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Applied via site")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View the analysis" })).toHaveAttribute(
      "href",
      "/analyses/a1",
    );
    expect(screen.getByRole("link", { name: "View the Scout" })).toHaveAttribute(
      "href",
      "/scouts?open=scout-1",
    );
  });

  it("shows the '—' placeholder, not a blank line, when the offer has no company", async () => {
    server.use(
      http.get("/api/applications/app-1", () =>
        HttpResponse.json({
          application: {
            ...application({ jobOffer: { id: "job1", title: "Backend Engineer", company: null } }),
            statusEvents: [],
          },
        }),
      ),
    );

    renderWithProviders(<ApplicationDetailPage />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the empty timeline state when no StatusEvents exist yet", async () => {
    server.use(
      http.get("/api/applications/app-1", () =>
        HttpResponse.json({ application: { ...application(), statusEvents: [] } }),
      ),
    );

    renderWithProviders(<ApplicationDetailPage />);

    expect(await screen.findByText("No status changes yet.")).toBeInTheDocument();
  });

  it("advances the status by appending a StatusEvent via the move-to control", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/applications/app-1", () =>
        HttpResponse.json({ application: { ...application(), statusEvents: [] } }),
      ),
      http.post("/api/applications/app-1/status-events", () =>
        HttpResponse.json({
          application: application({ status: "APPLIED" }),
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

    renderWithProviders(<ApplicationDetailPage />);
    await screen.findByText("Backend Engineer");

    await user.selectOptions(screen.getByLabelText("Move to…"), "APPLIED");

    expect(await screen.findByText("Applied")).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    server.use(
      http.get("/api/applications/app-1", () =>
        HttpResponse.json({ error: "boom" }, { status: 404 }),
      ),
    );

    renderWithProviders(<ApplicationDetailPage />);

    expect(
      await screen.findByText("We couldn't load this application. Please try again."),
    ).toBeInTheDocument();
  });
});
