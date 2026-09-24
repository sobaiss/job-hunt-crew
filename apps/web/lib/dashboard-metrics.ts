import type { AnalysesTrendPoint } from "@/hooks/use-analyses";
import type { CvVersion } from "@/hooks/use-cv-versions";
import type { Scout } from "@/hooks/use-scouts";

// Pure, framework-free helpers behind the Dashboard (`components/dashboard.tsx`).
// The counts and the scores themselves are now `GET /api/analyses/stats`'s
// answer (docs/adr/0033) — deriving them here meant fetching every Analysis,
// which is the one thing paginating the list was meant to stop. What is left
// here is what is still a *derivation*: the moving average drawn over the
// stats' raw score series, and the three onboarding conditions.

/**
 * The onboarding checklist state, derived from data every render — never
 * persisted, never manually ticked (spec #43):
 *
 * - `hasCv`        — at least one CVVersion
 * - `hasAnalysis`  — at least one Analysis
 * - `hasComparison`— at least one JobOffer with two or more analyses
 */
export type OnboardingSteps = {
  hasCv: boolean;
  hasAnalysis: boolean;
  hasComparison: boolean;
};

export function onboardingSteps(
  { analysisCount, hasComparison }: { analysisCount: number; hasComparison: boolean },
  cvVersionCount: number,
): OnboardingSteps {
  return {
    hasCv: cvVersionCount > 0,
    hasAnalysis: analysisCount > 0,
    hasComparison,
  };
}

/**
 * The Match score trend: a cumulative moving average over the scored analyses
 * `GET /api/analyses/stats` returns, which are already oldest-first and
 * already only the scored ones. Each point carries the raw score too so the
 * chart can plot both if it wants.
 */
export type TrendPoint = {
  index: number;
  requestedAt: string;
  score: number;
  movingAverage: number;
};

/** Label of the Candidate's default CV version — the "CV versions" stat
 *  tile's caption. `null` when no version is currently marked default. */
export function defaultCvLabel(
  cvVersions: Pick<CvVersion, "label" | "isDefault">[],
): string | null {
  return cvVersions.find((cv) => cv.isDefault)?.label ?? null;
}

/**
 * The Dashboard's "N new matches from your agents" block (issue #56): the
 * cross-Scout count of un-actioned relevant finds. There is no "actioned"
 * tracking yet (Application lands in slice 7 / #59), so this is currently
 * just the sum of every Scout's `relevantFindsCount` — zero-safe with no
 * Scouts.
 */
export function newMatchesCount(scouts: Scout[]): number {
  return scouts.reduce((sum, scout) => sum + scout.relevantFindsCount, 0);
}

export function scoreTrend(points: AnalysesTrendPoint[]): TrendPoint[] {
  let runningSum = 0;
  return points.map((point, index) => {
    runningSum += point.score;
    return {
      index,
      requestedAt: point.requestedAt,
      score: point.score,
      movingAverage: Math.round(runningSum / (index + 1)),
    };
  });
}
