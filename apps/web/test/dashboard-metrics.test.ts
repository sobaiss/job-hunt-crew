import { describe, expect, it } from "vitest";

import {
  defaultCvLabel,
  newMatchesCount,
  onboardingSteps,
  scoreTrend,
} from "@/lib/dashboard-metrics";
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
    ...overrides,
  };
}

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
  it("derives each step from the stats and the CV count", () => {
    expect(
      onboardingSteps({ analysisCount: 0, hasComparison: false }, 0),
    ).toEqual({
      hasCv: false,
      hasAnalysis: false,
      hasComparison: false,
    });
    expect(
      onboardingSteps({ analysisCount: 1, hasComparison: false }, 1),
    ).toEqual({
      hasCv: true,
      hasAnalysis: true,
      hasComparison: false,
    });
  });

  it("takes the comparison step from the stats' own verdict", () => {
    // Which JobOffer has two analyses is a GROUP BY the server runs over every
    // row; the browser holds one page and could not answer it.
    expect(
      onboardingSteps({ analysisCount: 2, hasComparison: true }, 1).hasComparison,
    ).toBe(true);
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
  it("is a cumulative moving average over the points the stats endpoint gives", () => {
    // Which analyses count as scored, and their order, are settled server-side
    // now; what is left here is the running average drawn over them.
    const trend = scoreTrend([
      { requestedAt: "2026-08-01T00:00:00.000Z", score: 60 },
      { requestedAt: "2026-08-02T00:00:00.000Z", score: 90 },
    ]);

    expect(trend.map((p) => p.movingAverage)).toEqual([60, 75]);
    expect(trend.map((p) => p.score)).toEqual([60, 90]);
  });

  it("is empty when nothing has been scored yet", () => {
    expect(scoreTrend([])).toEqual([]);
  });
});
