import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import ScoutsPage from "@/app/(app)/scouts/page";
import NewScoutPage from "@/app/(app)/scouts/new/page";
import ScoutDetailPage from "@/app/(app)/scouts/[id]/page";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ id: "scout-1" }),
}));

beforeEach(() => {
  push.mockReset();
});

function cv(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv-default",
    label: "Default CV",
    fileName: "cv.pdf",
    fileType: "PDF",
    fileSizeBytes: 1234,
    isDefault: true,
    conversionStatus: "CONVERTED",
    conversionError: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function scout(overrides: Record<string, unknown> = {}) {
  return {
    id: "scout-1",
    userId: "user_1",
    label: "Senior Backend — Remote EU",
    cvVersionId: "cv-default",
    targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN"],
    filters: {
      keywords: "python",
      location: null,
      postedWithin: "7d",
      contractType: null,
      remote: null,
      experienceLevel: null,
    },
    matchThreshold: 70,
    status: "ACTIVE",
    lastRunAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScoutsPage — list", () => {
  it("lists each Scout with its status and base CV and a New Scout link", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(
      await screen.findByRole("link", { name: "Senior Backend — Remote EU" }),
    ).toHaveAttribute("href", "/scouts/scout-1");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Default CV/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New Scout" })).toHaveAttribute(
      "href",
      "/scouts/new",
    );
  });

  it("shows an empty state when there are no Scouts", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(
      await screen.findByText("You don't have any Scouts yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't load your Scouts.",
    );
  });
});

describe("NewScoutPage — create form", () => {
  it("pre-checks France Travail and defaults the threshold to 70", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<NewScoutPage />);

    const franceTravail = await screen.findByRole("checkbox", {
      name: "France Travail",
    });
    expect(franceTravail).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "LinkedIn" })).not.toBeChecked();
    expect(screen.getByLabelText("Relevance threshold")).toHaveValue(70);
  });

  it("validates an empty label and at least one site", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.click(await screen.findByRole("checkbox", { name: "France Travail" }));
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    expect(
      await screen.findByText("Give this Scout a label."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose at least one job site."),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("submits the configured Scout and redirects to the list", async () => {
    const received: unknown[] = [];
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ scout: scout() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(
      await screen.findByLabelText("Label"),
      "Senior Backend — Remote EU",
    );
    await user.click(screen.getByRole("checkbox", { name: "LinkedIn" }));
    await user.type(screen.getByLabelText("Keywords"), "python");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/scouts"));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      label: "Senior Backend — Remote EU",
      cvVersionId: "cv-default",
      targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN"],
      matchThreshold: 70,
      filters: { keywords: "python", postedWithin: "7d" },
    });
  });

  it("submits the shared job-search filters (contract type, remote, experience level)", async () => {
    const received: unknown[] = [];
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ scout: scout() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(await screen.findByLabelText("Label"), "Filtered Scout");
    await user.type(screen.getByLabelText("Contract type"), "CDI");
    await user.selectOptions(screen.getByLabelText("Remote policy"), "remote");
    await user.type(screen.getByLabelText("Experience level"), "senior");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      filters: {
        contractType: "CDI",
        remote: "remote",
        experienceLevel: "senior",
        postedWithin: "7d",
      },
    });
  });

  it("shows an error when the server rejects the create (e.g. Scout cap)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", () =>
        HttpResponse.json(
          { error: "You can have at most 5 active Scouts." },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(await screen.findByLabelText("Label"), "Sixth Scout");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't save that Scout.");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("ScoutDetailPage — Run now + run history", () => {
  const scoutRun = (overrides: Record<string, unknown> = {}) => ({
    id: "run-1",
    scoutId: "scout-1",
    status: "COMPLETED",
    sitesQueried: 2,
    siteUnavailableCount: 0,
    offersDiscovered: 0,
    offersAnalysed: 0,
    relevantCount: 0,
    failedCount: 0,
    alreadySeenCount: 0,
    runLimitSkippedCount: 0,
    capSkippedCount: 0,
    errorMessage: null,
    startedAt: "2026-09-11T00:00:00.000Z",
    finishedAt: "2026-09-11T00:00:05.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  });

  it("triggers a run and shows the run history", async () => {
    const runPosts: unknown[] = [];
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () =>
        HttpResponse.json({ scoutRuns: runPosts.length ? [scoutRun()] : [] }),
      ),
      http.post("/api/scouts/scout-1/run", () => {
        runPosts.push(true);
        return HttpResponse.json({ scoutRun: scoutRun({ status: "PENDING" }) }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutDetailPage />);

    expect(await screen.findByText("This Scout hasn't run yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() => expect(runPosts).toHaveLength(1));
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("2 sites queried")).toBeInTheDocument();
  });

  it("surfaces the once-per-hour rate limit", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.post("/api/scouts/scout-1/run", () =>
        HttpResponse.json(
          { error: "This Scout ran within the last hour. Try again later." },
          { status: 429 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutDetailPage />);

    await user.click(await screen.findByRole("button", { name: "Run now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This Scout ran within the last hour.");
  });

  it("surfaces the cost-bounded-matching skip counts when non-zero", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () =>
        HttpResponse.json({
          scoutRuns: [
            scoutRun({
              alreadySeenCount: 3,
              runLimitSkippedCount: 2,
              capSkippedCount: 1,
            }),
          ],
        }),
      ),
    );
    renderWithProviders(<ScoutDetailPage />);

    expect(await screen.findByText("3 already seen")).toBeInTheDocument();
    expect(screen.getByText("2 not analysed — run limit")).toBeInTheDocument();
    expect(screen.getByText("1 not analysed — daily limit")).toBeInTheDocument();
  });
});

describe("ScoutDetailPage — relevant finds (issue #56)", () => {
  function find(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      status: "COMPLETED",
      matchScore: 85,
      requestedAt: "2026-09-11T00:00:00.000Z",
      cvVersionId: "cv-default",
      ingestionJobId: "job-1",
      scoutId: "scout-1",
      ingestionJob: null,
      jobOffer: { id: "offer-1", title: "Backend Engineer", company: "Acme" },
      cvVersion: { label: "Default CV" },
      resultJSON: null,
      errorMessage: null,
      ...overrides,
    };
  }

  it("lists relevant finds separately from found — low fit", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.get("/api/scouts/scout-1/finds", () =>
        HttpResponse.json({
          relevantFinds: [find({ id: "a1", jobOffer: { id: "o1", title: "Backend Engineer", company: "Acme" } })],
          lowFitFinds: [find({ id: "a2", matchScore: 40, jobOffer: { id: "o2", title: "Support Rep", company: "Beta" } })],
        }),
      ),
    );

    renderWithProviders(<ScoutDetailPage />);

    const relevant = within(
      (await screen.findByText("Relevant finds")).closest("div") as HTMLElement,
    );
    expect(relevant.getByText("Backend Engineer")).toBeInTheDocument();

    const lowFit = within(
      screen.getByText("Found — low fit").closest("div") as HTMLElement,
    );
    expect(lowFit.getByText("Support Rep")).toBeInTheDocument();
  });

  it("shows an empty state when there are no relevant finds yet, and hides the low-fit card", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.get("/api/scouts/scout-1/finds", () =>
        HttpResponse.json({ relevantFinds: [], lowFitFinds: [] }),
      ),
    );

    renderWithProviders(<ScoutDetailPage />);

    expect(await screen.findByText("No relevant finds yet.")).toBeInTheDocument();
    expect(screen.queryByText("Found — low fit")).not.toBeInTheDocument();
  });
});

describe("ScoutDetailPage — stats and patterns (issue #60)", () => {
  it("shows the scoped stats header", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.get("/api/scouts/scout-1/stats", () =>
        HttpResponse.json({
          allTime: {
            offersDiscovered: 40,
            relevantFinds: 5,
            documentsGenerated: 2,
            applicationsSubmitted: 1,
            responseRate: 100,
            interviewRate: 0,
            offerRate: 0,
            acceptanceRate: 0,
            medianDaysToFirstResponse: 4,
          },
          last30Days: {
            offersDiscovered: 40,
            relevantFinds: 5,
            documentsGenerated: 2,
            applicationsSubmitted: 1,
            responseRate: 100,
            interviewRate: 0,
            offerRate: 0,
            acceptanceRate: 0,
            medianDaysToFirstResponse: 4,
          },
        }),
      ),
    );

    renderWithProviders(<ScoutDetailPage />);

    expect(await screen.findByText("Offers discovered")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("ranks the patterns panel's missing skills by frequency", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.get("/api/scouts/scout-1/patterns", () =>
        HttpResponse.json({
          patterns: [
            { skill: "Kubernetes", count: 3 },
            { skill: "GraphQL", count: 1 },
          ],
        }),
      ),
    );

    renderWithProviders(<ScoutDetailPage />);

    expect(await screen.findByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("GraphQL")).toBeInTheDocument();
  });

  it("shows an empty state when there are no patterns yet", async () => {
    server.use(
      http.get("/api/scouts/scout-1", () => HttpResponse.json({ scout: scout() })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.get("/api/scouts/scout-1/patterns", () => HttpResponse.json({ patterns: [] })),
    );

    renderWithProviders(<ScoutDetailPage />);

    expect(
      await screen.findByText("No patterns yet — they'll appear as relevant finds accumulate."),
    ).toBeInTheDocument();
  });
});
