import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import ApplicationsPage from "@/app/(app)/applications/page";
import ApplicationDetailPage from "@/app/(app)/applications/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "app-1" }),
}));

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

describe("ApplicationsPage — list", () => {
  it("lists each Application with its offer, CV version, and status", async () => {
    server.use(
      http.get("/api/applications", () =>
        HttpResponse.json({ applications: [application()] }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Acme Inc")).toBeInTheDocument();
    expect(within(row).getByText(/Grad CV/)).toBeInTheDocument();
    expect(within(row).getByText("Draft")).toBeInTheDocument();
  });

  it("shows an empty state when there are no Applications", async () => {
    server.use(
      http.get("/api/applications", () => HttpResponse.json({ applications: [] })),
    );

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("No applications tracked yet.")).toBeInTheDocument();
  });

  it("re-fetches with a status filter when the status control changes", async () => {
    const user = userEvent.setup();
    let lastUrl = "";
    server.use(
      http.get("/api/applications", ({ request }) => {
        lastUrl = request.url;
        return HttpResponse.json({ applications: [application()] });
      }),
    );

    renderWithProviders(<ApplicationsPage />);
    await screen.findByText("Backend Engineer");

    await user.selectOptions(screen.getByLabelText("Status"), "APPLIED");

    await screen.findByText("Backend Engineer");
    expect(lastUrl).toContain("status=APPLIED");
  });
});

describe("ApplicationsPage — stats header (issue #60)", () => {
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

  it("shows all-time metrics by default and switches to the last-30-days window", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/applications", () => HttpResponse.json({ applications: [] })),
      http.get("/api/applications/stats", () =>
        HttpResponse.json({
          allTime: statsWindow({ applicationsSubmitted: 12, responseRate: 50 }),
          last30Days: statsWindow({ applicationsSubmitted: 3, responseRate: 33.3 }),
        }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("12")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Last 30 days" }));

    expect(await screen.findByText("3")).toBeInTheDocument();
  });

  it("is zero-safe with no data", async () => {
    server.use(
      http.get("/api/applications", () => HttpResponse.json({ applications: [] })),
      http.get("/api/applications/stats", () =>
        HttpResponse.json({ allTime: statsWindow(), last30Days: statsWindow() }),
      ),
    );

    renderWithProviders(<ApplicationsPage />);

    expect(await screen.findByText("Applications submitted")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
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
      "/scouts/scout-1",
    );
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
