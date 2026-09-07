import { describe, expect, it } from "vitest";

import {
  cvLabelsOf,
  filterAnalyses,
  DEFAULT_ANALYSES_FILTERS,
} from "@/lib/analyses-filters";
import type { AnalysisSummary } from "@/hooks/use-analyses";

function summary(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
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
    ...overrides,
  };
}

describe("filterAnalyses", () => {
  const list = [
    summary({ id: "a1" }),
    summary({
      id: "a2",
      status: "FAILED",
      jobOffer: { id: "job2", title: "Frontend Dev", company: "Globex" },
      cvVersion: { label: "Senior CV" },
    }),
    summary({
      id: "a3",
      status: "RUNNING_CREW",
      jobOffer: { id: "job3", title: "Platform Engineer", company: "Acme Inc" },
      cvVersion: { label: "Grad CV" },
    }),
  ];

  it("returns everything with the default filters", () => {
    expect(filterAnalyses(list, DEFAULT_ANALYSES_FILTERS)).toEqual(list);
  });

  it("matches the search term against the offer title and company, case-insensitively", () => {
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        search: "acme",
      }).map((a) => a.id),
    ).toEqual(["a1", "a3"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        search: "frontend",
      }).map((a) => a.id),
    ).toEqual(["a2"]);
  });

  it("filters by status and by CVVersion label, and combines the two", () => {
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        status: "FAILED",
      }).map((a) => a.id),
    ).toEqual(["a2"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        cvLabel: "Grad CV",
      }).map((a) => a.id),
    ).toEqual(["a1", "a3"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        cvLabel: "Grad CV",
        status: "RUNNING_CREW",
      }).map((a) => a.id),
    ).toEqual(["a3"]);
  });
});

describe("cvLabelsOf", () => {
  it("lists the distinct labels in first-seen order", () => {
    expect(
      cvLabelsOf([
        summary({ cvVersion: { label: "Grad CV" } }),
        summary({ cvVersion: { label: "Senior CV" } }),
        summary({ cvVersion: { label: "Grad CV" } }),
      ]),
    ).toEqual(["Grad CV", "Senior CV"]);
  });
});
