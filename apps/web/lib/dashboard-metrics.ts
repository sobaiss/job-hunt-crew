import type { AnalysisSummary } from "@/hooks/use-analyses";
import type { CvVersion } from "@/hooks/use-cv-versions";
import type { Scout } from "@/hooks/use-scouts";

// Pure, framework-free helpers behind the Dashboard (`components/dashboard.tsx`).
// Every number the Dashboard shows is derived here from the payload the
// `/api/analyses` list already returns plus the `/api/cv-versions` count — no
// BFF change, no new endpoint, no new query parameter (spec #43).

/** An Analysis is only counted towards scores once it has a real result. */
function isScored(
  analysis: AnalysisSummary,
): analysis is AnalysisSummary & { matchScore: number } {
  return analysis.status === "COMPLETED" && analysis.matchScore !== null;
}

export type DashboardStats = {
  analysisCount: number;
  /** Mean match score over completed analyses, rounded; `null` when none. */
  averageScore: number | null;
  /** Best match score over completed analyses; `null` when none. */
  bestScore: number | null;
  cvVersionCount: number;
};

export function computeStats(
  analyses: AnalysisSummary[],
  cvVersionCount: number,
): DashboardStats {
  const scores = analyses.filter(isScored).map((a) => a.matchScore);
  const averageScore =
    scores.length > 0
      ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length)
      : null;
  return {
    analysisCount: analyses.length,
    averageScore,
    bestScore: scores.length > 0 ? Math.max(...scores) : null,
    cvVersionCount: cvVersionCount,
  };
}

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
  analyses: AnalysisSummary[],
  cvVersionCount: number,
): OnboardingSteps {
  const perOffer = new Map<string, number>();
  for (const a of analyses) {
    perOffer.set(a.jobOffer.id, (perOffer.get(a.jobOffer.id) ?? 0) + 1);
  }
  return {
    hasCv: cvVersionCount > 0,
    hasAnalysis: analyses.length > 0,
    hasComparison: [...perOffer.values()].some((count) => count >= 2),
  };
}

/**
 * The Match score trend: a cumulative moving average of `matchScore` over
 * completed analyses ordered oldest-first by `requestedAt`. Each point carries
 * the raw score too so the chart can plot both if it wants.
 */
export type TrendPoint = {
  index: number;
  requestedAt: string;
  score: number;
  movingAverage: number;
};

/** The job offer identity of the Analysis carrying {@link DashboardStats.bestScore}
 *  — the "Best score" stat tile's caption in the reviewed mockup
 *  (design/Shell.dc.html). `null` until at least one Analysis is scored. */
export function bestScoreOffer(
  analyses: AnalysisSummary[],
): { title: string | null; company: string | null } | null {
  const scored = analyses.filter(isScored);
  if (scored.length === 0) return null;
  const best = scored.reduce((a, b) => (b.matchScore > a.matchScore ? b : a));
  return { title: best.jobOffer.title, company: best.jobOffer.company };
}

/** Count of Analyses requested within the trailing 7 days from `now` — the
 *  "Analyses" stat tile's caption. `now` defaults to the wall clock and is
 *  only overridden by tests. */
export function analysesThisWeek(
  analyses: AnalysisSummary[],
  now: number = Date.now(),
): number {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  return analyses.filter(
    (a) => now - new Date(a.requestedAt).getTime() <= WEEK_MS,
  ).length;
}

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

export function scoreTrend(analyses: AnalysisSummary[]): TrendPoint[] {
  const ordered = analyses
    .filter(isScored)
    .slice()
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));

  let runningSum = 0;
  return ordered.map((a, index) => {
    runningSum += a.matchScore;
    return {
      index,
      requestedAt: a.requestedAt,
      score: a.matchScore,
      movingAverage: Math.round(runningSum / (index + 1)),
    };
  });
}
