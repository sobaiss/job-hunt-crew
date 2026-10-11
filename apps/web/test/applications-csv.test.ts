import { describe, expect, it } from "vitest";

import { applicationsToCsv } from "@/lib/applications-csv";
import type { ApplicationSummary } from "@/lib/applications-filters";

const labelers = {
  sourceSiteLabel: (value: string) => (value === "FRANCE_TRAVAIL" ? "France Travail" : value),
  trackingStatusLabel: (value: string) => (value === "IN_PROGRESS" ? "In progress" : value),
  documentStatusLabel: (value: string) => (value === "READY" ? "Ready" : value),
};

function application(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    id: "app1",
    userId: "u1",
    analysisId: "a1",
    jobOfferId: "job1",
    cvVersionId: "cv1",
    scoutId: null,
    coverLetterDocId: null,
    tailoredCvDocId: null,
    status: "INTERVIEWING",
    appliedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme, Inc",
      location: "Paris",
      sourceSite: "FRANCE_TRAVAIL",
    },
    cvVersion: { label: "Grad CV" },
    matchScore: 87,
    tailoredCvStatus: "READY",
    coverLetterStatus: "FAILED",
    ...overrides,
  };
}

describe("applicationsToCsv", () => {
  it("emits the header row plus one row per application, in the given order", () => {
    const csv = applicationsToCsv(
      [
        application(),
        application({ id: "app2", jobOffer: { ...application().jobOffer, title: "Frontend Developer" } }),
      ],
      labelers,
    );
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Position,Company,Location,Platform,Applied,Score,Status,Tailored CV,Cover letter",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Backend Engineer");
    expect(lines[2]).toContain("Frontend Developer");
  });

  it("serialises a known fixture, folding the status into its Tracking bucket", () => {
    const [, row] = applicationsToCsv([application()], labelers).split("\n");
    expect(row).toBe(
      'Backend Engineer,"Acme, Inc",Paris,France Travail,2026-08-01T00:00:00.000Z,87,In progress,Ready,FAILED',
    );
  });

  it("renders null fields as empty cells, never the string \"null\"", () => {
    const [, row] = applicationsToCsv(
      [
        application({
          appliedAt: null,
          matchScore: null,
          tailoredCvStatus: null,
          coverLetterStatus: null,
          jobOffer: { id: "job1", title: null, company: null, location: null, sourceSite: null },
        }),
      ],
      labelers,
    ).split("\n");
    expect(row).toBe(",,,,,,In progress,,");
    expect(row).not.toContain("null");
  });

  it("renders fields the list response does not carry yet as empty cells", () => {
    const [, row] = applicationsToCsv(
      [
        application({
          matchScore: undefined,
          tailoredCvStatus: undefined,
          coverLetterStatus: undefined,
          jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme" },
        }),
      ],
      labelers,
    ).split("\n");
    expect(row).toBe("Backend Engineer,Acme,,,2026-08-01T00:00:00.000Z,,In progress,,");
  });

  it("escapes commas, quotes and newlines in a field", () => {
    const csv = applicationsToCsv(
      [application({ jobOffer: { ...application().jobOffer, title: 'Say "hi",\nplease' } })],
      labelers,
    );
    expect(csv).toContain('\n"Say ""hi"",\nplease","Acme, Inc",');
  });
});
