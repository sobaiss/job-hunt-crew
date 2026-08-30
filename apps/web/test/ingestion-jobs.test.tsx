import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import NewSiteSearchIngestionJobPage from "@/app/(app)/ingestion-jobs/new/page";
import IngestionJobPage from "@/app/(app)/ingestion-jobs/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "j1" }),
}));

const SITE = {
  id: "s1",
  siteKey: "WELCOME_TO_THE_JUNGLE",
  displayName: "Welcome to the Jungle",
};

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

describe("NewSiteSearchIngestionJobPage", () => {
  it("shows a validation error when submitting without choosing a site", async () => {
    server.use(
      http.get("/api/site-configs", () =>
        HttpResponse.json({ siteConfigs: [SITE] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewSiteSearchIngestionJobPage />);

    await user.click(
      await screen.findByRole("button", { name: "Start ingestion" }),
    );

    expect(
      await screen.findByText("Choose a site to search."),
    ).toBeInTheDocument();
  });

  it("creates the ingestion job and links to its progress page", async () => {
    let createBody: Record<string, unknown> | null = null;
    server.use(
      http.get("/api/site-configs", () =>
        HttpResponse.json({ siteConfigs: [SITE] }),
      ),
      http.post("/api/ingestion-jobs", async ({ request }) => {
        createBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ingestionJob: job({ status: "PENDING", id: "job9" }) },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewSiteSearchIngestionJobPage />);

    await user.selectOptions(await screen.findByLabelText("Site"), "s1");
    await user.type(screen.getByLabelText("Keywords"), "React");
    await user.click(screen.getByRole("button", { name: "Start ingestion" }));

    expect(
      await screen.findByText("Ingestion job started."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View progress" }),
    ).toHaveAttribute("href", "/ingestion-jobs/job9");
    expect(createBody).toMatchObject({
      mode: "SITE_SEARCH",
      siteConfigId: "s1",
      filters: { keywords: "React", postedWithin: "any" },
    });
  });

  it("shows an error state when the site list fails to load", async () => {
    server.use(
      http.get("/api/site-configs", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderWithProviders(<NewSiteSearchIngestionJobPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load the job sites/i,
    );
  });
});

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
