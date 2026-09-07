import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import BatchResultPage from "@/app/(app)/analyses/batch/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "j1" }),
}));

function analysisRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 50,
    requestedAt: "2026-08-01T00:00:00.000Z",
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme" },
    cvVersion: { label: "Default CV" },
    resultJSON: null,
    errorMessage: null,
    ...overrides,
  };
}

type StubOptions = {
  jobStatus?: string;
  discoveredCount?: number;
  analyses?: ReturnType<typeof analysisRow>[];
  onJobFetch?: () => void;
};

function stubApi(options: StubOptions = {}) {
  const {
    jobStatus = "COMPLETED",
    discoveredCount = 0,
    analyses = [],
    onJobFetch,
  } = options;

  server.use(
    http.get("/api/ingestion-jobs/j1", () => {
      onJobFetch?.();
      return HttpResponse.json({
        ingestionJob: {
          id: "j1",
          mode: "SITE_SEARCH",
          status: jobStatus,
          discoveredCount,
          scrapedCount: 0,
          failedCount: 0,
          quotaSkippedCount: 0,
          errorMessage: null,
          jobOffers: [],
        },
      });
    }),
    http.get("/api/analyses", () => HttpResponse.json({ analyses })),
  );
}

describe("BatchResultPage", () => {
  it("renders the batch's analyses ranked by Match score, each linking to its detail", async () => {
    stubApi({
      jobStatus: "COMPLETED",
      discoveredCount: 2,
      analyses: [
        analysisRow({ id: "a-low", matchScore: 30 }),
        analysisRow({
          id: "a-high",
          matchScore: 88,
          jobOffer: { id: "job2", title: "Staff Engineer", company: "Globex" },
        }),
      ],
    });

    renderWithProviders(<BatchResultPage />);

    expect(
      await screen.findByRole("heading", { name: "Analyse several offers" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Offers found")).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: /Engineer/ });
    expect(links[0]).toHaveAttribute("href", "/analyses/a-high");
    expect(links[1]).toHaveAttribute("href", "/analyses/a-low");

    expect(
      screen.getByRole("link", { name: "Scraping progress" }),
    ).toHaveAttribute("href", "/ingestion-jobs/j1");
  });

  it("shows each scored analysis as a match-score gauge and a two-phase progress bar", async () => {
    stubApi({
      jobStatus: "COMPLETED",
      discoveredCount: 2,
      analyses: [
        analysisRow({ id: "a-high", matchScore: 88 }),
        analysisRow({
          id: "a-pending",
          status: "RUNNING_CREW",
          matchScore: null,
        }),
      ],
    });

    renderWithProviders(<BatchResultPage />);

    // The completed analysis is shown with the shared Match-score gauge…
    expect(
      await screen.findByRole("img", { name: "Match score 88 out of 100" }),
    ).toBeInTheDocument();
    // …and the still-running one keeps its status badge until a score lands.
    expect(screen.getByText("Running")).toBeInTheDocument();

    // Phase 2 progress: one of the two analyses is terminal -> 50%.
    const bar = screen.getByRole("progressbar", { name: "Analyses completed" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("stops polling the job once it is terminal and every analysis is too", async () => {
    let jobCalls = 0;
    stubApi({
      jobStatus: "COMPLETED",
      analyses: [analysisRow()],
      onJobFetch: () => {
        jobCalls += 1;
      },
    });

    vi.useFakeTimers();
    try {
      renderWithProviders(<BatchResultPage />);

      await vi.waitFor(() => expect(jobCalls).toBeGreaterThan(0));
      const callsAfterSettled = jobCalls;

      await vi.advanceTimersByTimeAsync(10000);
      expect(jobCalls).toBe(callsAfterSettled);
    } finally {
      vi.useRealTimers();
    }
  });
});
