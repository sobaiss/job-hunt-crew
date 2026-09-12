import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { Dashboard } from "@/components/dashboard";

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv1",
    ingestionJobId: null,
    ingestionJob: null,
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
    cvVersion: { label: "Grad CV" },
    resultJSON: null,
    errorMessage: null,
    ...overrides,
  };
}

function stub(options: {
  analyses?: unknown[];
  analysesStatus?: number;
  cvVersions?: unknown[];
  scouts?: unknown[];
}) {
  server.use(
    http.get("/api/analyses", () =>
      options.analysesStatus
        ? HttpResponse.json({ error: "boom" }, { status: options.analysesStatus })
        : HttpResponse.json({ analyses: options.analyses ?? [] }),
    ),
    http.get("/api/cv-versions", () =>
      HttpResponse.json({ cvVersions: options.cvVersions ?? [] }),
    ),
    http.get("/api/scouts", () =>
      HttpResponse.json({ scouts: options.scouts ?? [] }),
    ),
  );
}

describe("Dashboard", () => {
  it("shows a loading state while the data is in flight", () => {
    stub({ analyses: [], cvVersions: [] });
    renderWithProviders(<Dashboard />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows the onboarding checklist instead of stat tiles when there are no analyses", async () => {
    stub({ analyses: [], cvVersions: [{ id: "cv1" }] });

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

  it("computes the stat tiles from the analyses and cv-versions payloads", async () => {
    stub({
      analyses: [
        analysis({ id: "a1", matchScore: 60 }),
        analysis({ id: "a2", matchScore: 90 }),
        analysis({ id: "a3", status: "RUNNING_CREW", matchScore: null }),
      ],
      cvVersions: [{ id: "cv1" }, { id: "cv2" }],
    });

    renderWithProviders(<Dashboard />);

    const stats = within(
      (await screen.findByText("Average match score")).closest(
        "section",
      ) as HTMLElement,
    );
    expect(stats.getByText("75")).toBeInTheDocument(); // average of 60 and 90
    expect(stats.getByText("90")).toBeInTheDocument(); // best
    expect(stats.getByText("3")).toBeInTheDocument(); // analysis count
    expect(stats.getByText("2")).toBeInTheDocument(); // cv-version count
  });

  it("lists the recent analyses and the quick actions", async () => {
    stub({ analyses: [analysis()], cvVersions: [{ id: "cv1" }] });

    renderWithProviders(<Dashboard />);

    const recent = within(
      (await screen.findByText("Recent analyses")).closest(
        "section",
      ) as HTMLElement,
    );
    expect(recent.getByText("Backend Engineer")).toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: "Analyse one offer" }),
    ).toHaveAttribute("href", "/analyses/new");
    expect(
      screen.getByRole("link", { name: "Analyse several offers" }),
    ).toHaveAttribute("href", "/analyses/new/several");
    expect(
      screen.getByRole("link", { name: "Import a CV" }),
    ).toHaveAttribute("href", "/cv-versions");
  });

  it("renders the match-score trend once two analyses have completed", async () => {
    stub({
      analyses: [
        analysis({ id: "a1", matchScore: 60 }),
        analysis({ id: "a2", matchScore: 90 }),
      ],
      cvVersions: [{ id: "cv1" }],
    });

    renderWithProviders(<Dashboard />);

    expect(await screen.findByText("Match score trend")).toBeInTheDocument();
  });

  it("shows the cross-Scout new-matches block and links to Agents", async () => {
    stub({
      analyses: [analysis()],
      cvVersions: [{ id: "cv1" }],
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
      analyses: [analysis()],
      cvVersions: [{ id: "cv1" }],
      scouts: [{ id: "s1", relevantFindsCount: 0 }],
    });

    renderWithProviders(<Dashboard />);
    await screen.findByText("Backend Engineer");

    expect(screen.queryByText(/new matches from your agents/)).not.toBeInTheDocument();
  });

  it("shows an error state when a request fails", async () => {
    stub({ analysesStatus: 500, cvVersions: [] });

    renderWithProviders(<Dashboard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load your dashboard/i,
    );
  });
});
