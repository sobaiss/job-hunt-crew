import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import IngestionJobPage from "@/app/(app)/ingestion-jobs/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "j1" }),
}));

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "j1",
    mode: "SITE_SEARCH",
    status: "RUNNING",
    discoveredCount: 10,
    scrapedCount: 4,
    failedCount: 1,
    errorMessage: null,
    jobOffers: [],
    ...overrides,
  };
}

describe("IngestionJobPage", () => {
  it("renders the discovered / scraped / failed counts and the status", async () => {
    server.use(
      http.get("/api/ingestion-jobs/j1", () =>
        HttpResponse.json({ ingestionJob: job() }),
      ),
    );
    renderWithProviders(<IngestionJobPage />);

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Discovered")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("Scraped")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders a scraping-progress bar reflecting scraped / discovered", async () => {
    server.use(
      http.get("/api/ingestion-jobs/j1", () =>
        HttpResponse.json({
          ingestionJob: job({
            status: "RUNNING",
            discoveredCount: 10,
            scrapedCount: 4,
          }),
        }),
      ),
    );
    renderWithProviders(<IngestionJobPage />);

    const bar = await screen.findByRole("progressbar", {
      name: "Scraping progress",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("4 / 10")).toBeInTheDocument();
  });

  it("does not render the scraping-progress bar for a PENDING job", async () => {
    server.use(
      http.get("/api/ingestion-jobs/j1", () =>
        HttpResponse.json({
          ingestionJob: job({ status: "PENDING", discoveredCount: 10 }),
        }),
      ),
    );
    renderWithProviders(<IngestionJobPage />);

    await screen.findByText(/hasn't been picked up yet/i);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows an explicit waiting-to-start state for a PENDING job, not a spinner", async () => {
    server.use(
      http.get("/api/ingestion-jobs/j1", () =>
        HttpResponse.json({ ingestionJob: job({ status: "PENDING" }) }),
      ),
    );
    renderWithProviders(<IngestionJobPage />);

    expect(
      await screen.findByText(/hasn't been picked up yet/i),
    ).toBeInTheDocument();
    // The loading skeleton is gone: this is a real state, not a silent spinner.
    expect(
      screen.queryByLabelText("Loading this ingestion job"),
    ).toBeNull();
  });

  it("polls while non-terminal and stops once the job is terminal", async () => {
    let calls = 0;
    server.use(
      http.get("/api/ingestion-jobs/j1", () => {
        calls += 1;
        return HttpResponse.json({
          ingestionJob: job({
            status: calls === 1 ? "RUNNING" : "COMPLETED",
          }),
        });
      }),
    );

    vi.useFakeTimers();
    try {
      renderWithProviders(<IngestionJobPage />);

      await vi.waitFor(() => expect(calls).toBe(1));

      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(calls).toBe(2));

      const callsAfterTerminal = calls;
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls).toBe(callsAfterTerminal);
    } finally {
      vi.useRealTimers();
    }
  });
});
