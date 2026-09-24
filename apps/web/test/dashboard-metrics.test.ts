import { describe, expect, it } from "vitest";

import {
  analysesThisWeek,
  bestScoreOffer,
  computeStats,
  defaultCvLabel,
  newMatchesCount,
  onboardingSteps,
  scoreTrend,
} from "@/lib/dashboard-metrics";
import type { AnalysisSummary } from "@/hooks/use-analyses";
import type { CvVersion } from "@/hooks/use-cv-versions";
import type { Scout } from "@/hooks/use-scouts";

function scout(overrides: Partial<Scout> = {}): Scout {
  return {
    id: "s1",
    userId: "u1",
    label: "Scout",
    cvVersionId: "cv1",
    targetSiteKeys: ["FRANCE_TRAVAIL"],
    filters: {
      keywords: null,
      location: null,
      postedWithin: null,
      contractType: null,
      remote: null,
      experienceLevel: null,
    },
    matchThreshold: 70,
    status: "ACTIVE",
    lastRunAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    relevantFindsCount: 0,
    runState: "NEVER_RUN",
    runStateSince: null,
    blockedAnalysisIds: [],
    ...overrides,
  };
}

function analysis(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    requeuedAt: null,
    stuck: false,
    cvVersionId: "cv1",
    ingestionJobId: null,
    scoutId: null,
    applicationStatus: null,
    tailoredCvStatus: null,
    coverLetterStatus: null,
    ingestionJob: null,
    jobOffer: {
      id: "job1",
      title: "Role",
      company: "Co",
      location: "Paris",
      sourceSite: "OTHER",
      postedAt: null,
      sourceUrl: "https://example.com/jobs/job1",
    },
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

function cvVersion(overrides: Partial<CvVersion> = {}): CvVersion {
  return {
    id: "cv1",
    label: "CV",
    fileName: "cv.pdf",
    fileType: "PDF",
    fileSizeBytes: 1024,
    isDefault: false,
    conversionStatus: "CONVERTED",
    conversionError: null,
    supersededById: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("bestScoreOffer", () => {
  it("returns the job offer of the highest-scoring completed analysis", () => {
    expect(
      bestScoreOffer([
        analysis({
          id: "a1",
          matchScore: 60,
          jobOffer: {
            id: "job1",
            title: "Low",
            company: "LowCo",
            location: "Paris",
            sourceSite: "OTHER",
            postedAt: null,
            sourceUrl: "https://example.com/jobs/job1",
          },
        }),
        analysis({
          id: "a2",
          matchScore: 90,
          jobOffer: {
            id: "job2",
            title: "High",
            company: "HighCo",
            location: "Paris",
            sourceSite: "OTHER",
            postedAt: null,
            sourceUrl: "https://example.com/jobs/job2",
          },
        }),
      ]),
    ).toEqual({ title: "High", company: "HighCo" });
  });

  it("is null when nothing is scored", () => {
    expect(bestScoreOffer([analysis({ status: "QUEUED", matchScore: null })])).toBeNull();
  });
});

describe("analysesThisWeek", () => {
  const now = new Date("2026-08-10T00:00:00.000Z").getTime();

  it("counts only analyses requested within the trailing 7 days", () => {
    const count = analysesThisWeek(
      [
        analysis({ id: "a1", requestedAt: "2026-08-09T00:00:00.000Z" }),
        analysis({ id: "a2", requestedAt: "2026-08-04T00:00:00.000Z" }),
        analysis({ id: "a3", requestedAt: "2026-07-20T00:00:00.000Z" }),
      ],
      now,
    );
    expect(count).toBe(2);
  });

  it("is zero-safe with no analyses", () => {
    expect(analysesThisWeek([], now)).toBe(0);
  });
});

describe("defaultCvLabel", () => {
  it("returns the label of the default CV version", () => {
    expect(
      defaultCvLabel([
        cvVersion({ id: "cv1", label: "Backend", isDefault: false }),
        cvVersion({ id: "cv2", label: "Data — Fintech", isDefault: true }),
      ]),
    ).toBe("Data — Fintech");
  });

  it("is null when no version is marked default", () => {
    expect(defaultCvLabel([cvVersion({ isDefault: false })])).toBeNull();
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
        analysis({
          id: "a1",
          jobOffer: {
            id: "j1",
            title: null,
            company: null,
            location: null,
            sourceSite: "OTHER",
            postedAt: null,
            sourceUrl: "https://example.com/jobs/j1",
          },
        }),
        analysis({
          id: "a2",
          jobOffer: {
            id: "j1",
            title: null,
            company: null,
            location: null,
            sourceSite: "OTHER",
            postedAt: null,
            sourceUrl: "https://example.com/jobs/j1",
          },
        }),
      ],
      1,
    );
    expect(steps.hasComparison).toBe(true);
  });
});

describe("newMatchesCount", () => {
  it("sums relevantFindsCount across all Scouts", () => {
    expect(
      newMatchesCount([
        scout({ id: "s1", relevantFindsCount: 3 }),
        scout({ id: "s2", relevantFindsCount: 2 }),
      ]),
    ).toBe(5);
  });

  it("is zero-safe with no Scouts", () => {
    expect(newMatchesCount([])).toBe(0);
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
