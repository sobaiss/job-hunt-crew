import { describe, expect, it } from "vitest";

import { analysesToCsv } from "@/lib/analyses-csv";
import type { AnalysisSummary } from "@/hooks/use-analyses";

const labelers = {
  sourceSiteLabel: (value: string) => (value === "FRANCE_TRAVAIL" ? "France Travail" : value),
  pipelineStatusLabel: (value: string) => (value === "RUNNING_CREW" ? "Running" : value),
  trackingStatusLabel: (value: string) => (value === "TO_APPLY" ? "To apply" : value),
};

function analysis(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
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
    tailoredCvStatus: null,
    coverLetterStatus: null,
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme, Inc",
      location: "Paris",
      sourceSite: "FRANCE_TRAVAIL",
      postedAt: "2026-07-01T00:00:00.000Z",
      sourceUrl: "https://example.com/jobs/job1",
    },
    cvVersion: { label: "Grad CV" },
    ...overrides,
  };
}

describe("analysesToCsv", () => {
  it("emits a header row plus one row per analysis, in the given order", () => {
    const csv = analysesToCsv([analysis(), analysis({ id: "a2", jobOffer: { ...analysis().jobOffer, title: "Frontend Developer" } })], labelers);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "ID,Position,Company,Platform,Posted,Requested,CV,Score,Status,Link",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Backend Engineer");
    expect(lines[2]).toContain("Frontend Developer");
  });

  it("resolves the platform, score, status and link for a COMPLETED analysis", () => {
    const csv = analysesToCsv([analysis()], labelers);
    const [, row] = csv.split("\n");
    expect(row).toBe(
      "a1,Backend Engineer,\"Acme, Inc\",France Travail,2026-07-01T00:00:00.000Z,2026-08-01T00:00:00.000Z,Grad CV,87,To apply,https://example.com/jobs/job1",
    );
  });

  it("falls back to the pipeline status for a non-COMPLETED analysis", () => {
    const csv = analysesToCsv(
      [analysis({ status: "RUNNING_CREW", matchScore: null })],
      labelers,
    );
    const [, row] = csv.split("\n");
    expect(row).toContain(",Running,");
  });

  it("escapes commas, quotes and newlines in a field", () => {
    const csv = analysesToCsv(
      [
        analysis({
          jobOffer: { ...analysis().jobOffer, title: 'Say "hi", please' },
        }),
      ],
      labelers,
    );
    const [, row] = csv.split("\n");
    expect(row.startsWith('a1,"Say ""hi"", please",')).toBe(true);
  });
});
