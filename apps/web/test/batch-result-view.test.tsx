import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import { BatchResultView } from "@/components/batch-result-view";

function ingestionJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    mode: "SITE_SEARCH",
    status: "COMPLETED",
    discoveredCount: 1,
    scrapedCount: 1,
    failedCount: 0,
    quotaSkippedCount: 0,
    errorMessage: null,
    jobOffers: [],
    ...overrides,
  };
}

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 87,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv1",
    ingestionJobId: "job-1",
    ingestionJob: { mode: "SITE_SEARCH", siteConfigId: "site1" },
    scoutId: null,
    applicationStatus: null,
    jobOffer: {
      id: "joboffer-1",
      title: "Backend Engineer",
      company: "Acme Inc",
      location: "Paris",
      sourceSite: "HELLOWORK",
      postedAt: "2026-07-01T00:00:00.000Z",
      sourceUrl: "https://example.com/jobs/joboffer-1",
    },
    cvVersion: { label: "Grad CV" },
    resultJSON: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("BatchResultView", () => {
  it("shows the '—' placeholder, not a blank line, when an Analysis row's offer has no company", async () => {
    server.use(
      http.get("/api/ingestion-jobs/job-1", () =>
        HttpResponse.json({ ingestionJob: ingestionJob() }),
      ),
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [analysis({ jobOffer: { ...analysis().jobOffer, company: null } })],
        }),
      ),
    );

    renderWithProviders(<BatchResultView ingestionJobId="job-1" />);

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the '—' placeholder for a quota-skipped row's offer with no company", async () => {
    server.use(
      http.get("/api/ingestion-jobs/job-1", () =>
        HttpResponse.json({
          ingestionJob: ingestionJob({
            quotaSkippedCount: 1,
            jobOffers: [
              {
                jobOffer: {
                  id: "joboffer-2",
                  title: "Frontend Engineer",
                  company: null,
                  extractionStatus: "READY",
                },
              },
            ],
          }),
        }),
      ),
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [] })),
    );

    renderWithProviders(<BatchResultView ingestionJobId="job-1" />);

    expect(await screen.findByText("Frontend Engineer")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
