import type { AnalysisStatus, AnalysisSummary } from "@/hooks/use-analyses";

// Pure, framework-free helpers behind the Analyses-list controls (#44). Search,
// status filter and CVVersion filter all operate on the list already returned
// by `/api/analyses` — no new query parameter, no server work. Sorting is
// applied to the grouped rows in the page (a SITE_SEARCH batch sorts by its
// best score / its slot in the recency order).

export type AnalysesSort = "recent" | "score";

export type AnalysesFilterState = {
  /** Substring over JobOffer title + company, case-insensitive. */
  search: string;
  /** An `AnalysisStatus`, or `"all"` for no status filter. */
  status: AnalysisStatus | "all";
  /** A `cvVersion.label`, or `"all"` for no CVVersion filter. */
  cvLabel: string | "all";
  sort: AnalysesSort;
};

export const DEFAULT_ANALYSES_FILTERS: AnalysesFilterState = {
  search: "",
  status: "all",
  cvLabel: "all",
  sort: "recent",
};

/** The status filter's options, in pipeline order. */
export const ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  "PENDING",
  "QUEUED",
  "RUNNING_CREW",
  "AWAITING_RESULT",
  "PERSISTING",
  "COMPLETED",
  "FAILED",
];

/** Distinct CVVersion labels present in the list, in first-seen order. */
export function cvLabelsOf(analyses: AnalysisSummary[]): string[] {
  const seen = new Set<string>();
  for (const analysis of analyses) seen.add(analysis.cvVersion.label);
  return [...seen];
}

function matchesSearch(analysis: AnalysisSummary, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${analysis.jobOffer.title ?? ""} ${
    analysis.jobOffer.company ?? ""
  }`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * Narrow the analyses to those matching the search term, the status filter and
 * the CVVersion filter. Grouping and sorting are the caller's job — this runs
 * before {@link groupRows} so a batch row survives iff one of its analyses does.
 */
export function filterAnalyses(
  analyses: AnalysisSummary[],
  {
    search,
    status,
    cvLabel,
  }: Pick<AnalysesFilterState, "search" | "status" | "cvLabel">,
): AnalysisSummary[] {
  return analyses.filter(
    (analysis) =>
      matchesSearch(analysis, search) &&
      (status === "all" || analysis.status === status) &&
      (cvLabel === "all" || analysis.cvVersion.label === cvLabel),
  );
}
