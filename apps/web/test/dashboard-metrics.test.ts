import { describe, expect, it } from "vitest";

import {
  computeStats,
  onboardingSteps,
  scoreTrend,
} from "@/lib/dashboard-metrics";
import type { AnalysisSummary } from "@/hooks/use-analyses";

function analysis(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv1",
    ingestionJobId: null,
    ingestionJob: null,
    jobOffer: { id: "job1", title: "Role", company: "Co" },
    cvVersion: { label: "CV" },
    ...overrides,
  };
}

describe("computeStats", () => {
  it("averages and maxes only completed, scored analyses", () => {
    const stats = computeStats(
      [
        analysis({ id: "a1", matchScore: 60 }),
        analysis({ id: "a2", matchScore: 90 }),
        analysis({ id: "a3", status: "RUNNING_CREW", matchScore: null }),
        analysis({ id: "a4", status: "FAILED", matchScore: null }),
      ],
      3,
    );

    expect(stats.analysisCount).toBe(4);
    expect(stats.averageScore).toBe(75);
    expect(stats.bestScore).toBe(90);
    expect(stats.cvVersionCount).toBe(3);
  });

  it("returns null scores when nothing has completed", () => {
    const stats = computeStats(
      [analysis({ status: "QUEUED", matchScore: null })],
      0,
    );
    expect(stats.averageScore).toBeNull();
    expect(stats.bestScore).toBeNull();
  });
});

describe("onboardingSteps", () => {
  it("derives each step from the data", () => {
    expect(onboardingSteps([], 0)).toEqual({
      hasCv: false,
      hasAnalysis: false,
      hasComparison: false,
    });
    expect(onboardingSteps([analysis()], 1)).toEqual({
      hasCv: true,
      hasAnalysis: true,
      hasComparison: false,
    });
  });

  it("marks the comparison step once one job offer has two analyses", () => {
    const steps = onboardingSteps(
      [
        analysis({ id: "a1", jobOffer: { id: "j1", title: null, company: null } }),
        analysis({ id: "a2", jobOffer: { id: "j1", title: null, company: null } }),
      ],
      1,
    );
    expect(steps.hasComparison).toBe(true);
  });
});

describe("scoreTrend", () => {
  it("is a cumulative moving average over requestedAt-ordered completed analyses", () => {
    const trend = scoreTrend([
      analysis({ id: "a2", matchScore: 90, requestedAt: "2026-08-02T00:00:00.000Z" }),
      analysis({ id: "a1", matchScore: 60, requestedAt: "2026-08-01T00:00:00.000Z" }),
      analysis({ id: "a3", status: "FAILED", matchScore: null, requestedAt: "2026-08-03T00:00:00.000Z" }),
    ]);

    expect(trend.map((p) => p.movingAverage)).toEqual([60, 75]);
    expect(trend.map((p) => p.score)).toEqual([60, 90]);
  });
});
