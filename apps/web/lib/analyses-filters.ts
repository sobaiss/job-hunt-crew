import type { AnalysisSummary } from "@/hooks/use-analyses";
import { TRACKING_STATUSES, trackingStatusOf, type TrackingStatus } from "@/lib/tracking-status";

// Pure, framework-free helpers behind the Analyses table (#63). Search, status
// filter and CVVersion filter all operate on the list already returned by
// `/api/analyses` — no new query parameter, no server work. Sorting and
// pagination are likewise applied client-side to that same list. The page
// keeps this state in the URL query string (via `parseAnalysesTableState` /
// `analysesTableStateToParams`) so it survives a refresh and is shareable.

export type AnalysesFilterState = {
  /** Substring over JobOffer title + company, case-insensitive. */
  search: string;
  /** A Tracking status bucket (issue #64), or `"all"` for no status filter —
   *  "all" is the only way to see a non-`COMPLETED`/`FAILED` Analysis, since
   *  those have no Tracking status bucket of their own. */
  status: TrackingStatus | "all";
  /** A `cvVersion.label`, or `"all"` for no CVVersion filter. */
  cvLabel: string | "all";
};

export const DEFAULT_ANALYSES_FILTERS: AnalysesFilterState = {
  search: "",
  status: "all",
  cvLabel: "all",
};

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
 * Narrow the analyses to those matching the search term, the Tracking status
 * filter and the CVVersion filter. A specific Tracking status bucket only
 * ever matches a `COMPLETED` Analysis — a still-running or `FAILED` one has
 * no bucket and is excluded from every filter but `"all"`.
 */
export function filterAnalyses(
  analyses: AnalysisSummary[],
  { search, status, cvLabel }: AnalysesFilterState,
): AnalysisSummary[] {
  return analyses.filter(
    (analysis) =>
      matchesSearch(analysis, search) &&
      (status === "all" || trackingStatusOf(analysis) === status) &&
      (cvLabel === "all" || analysis.cvVersion.label === cvLabel),
  );
}

// --- Sorting ---

/** Every column the table can sort by, matching one field each. */
export type AnalysesSortColumn =
  | "title"
  | "company"
  | "location"
  | "sourceSite"
  | "postedAt"
  | "cvLabel"
  | "matchScore"
  | "sourceUrl";

export type AnalysesSortDirection = "asc" | "desc";

export type AnalysesSortState = {
  column: AnalysesSortColumn;
  direction: AnalysesSortDirection;
};

/** Publish date descending, per #63. */
export const DEFAULT_ANALYSES_SORT: AnalysesSortState = {
  column: "postedAt",
  direction: "desc",
};

const SORT_COLUMNS: readonly AnalysesSortColumn[] = [
  "title",
  "company",
  "location",
  "sourceSite",
  "postedAt",
  "cvLabel",
  "matchScore",
  "sourceUrl",
];

function sortValue(
  analysis: AnalysisSummary,
  column: AnalysesSortColumn,
): string | number | null {
  switch (column) {
    case "title":
      return analysis.jobOffer.title;
    case "company":
      return analysis.jobOffer.company;
    case "location":
      return analysis.jobOffer.location;
    case "sourceSite":
      return analysis.jobOffer.sourceSite;
    case "postedAt":
      return analysis.jobOffer.postedAt;
    case "cvLabel":
      return analysis.cvVersion.label;
    case "matchScore":
      return analysis.matchScore;
    case "sourceUrl":
      return analysis.jobOffer.sourceUrl;
  }
}

/**
 * Sorts by one column. A row with no value for that column (no score yet, no
 * postedAt) always sorts last regardless of direction, rather than landing at
 * the top of a descending sort. `requestedAt`-style ISO-8601 UTC timestamps
 * compare correctly as plain strings, so `postedAt` needs no Date parsing.
 */
export function sortAnalyses(
  analyses: AnalysisSummary[],
  sort: AnalysesSortState,
): AnalysisSummary[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...analyses].sort((a, b) => {
    const va = sortValue(a, sort.column);
    const vb = sortValue(b, sort.column);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * factor;
    }
    return String(va).localeCompare(String(vb)) * factor;
  });
}

// --- Pagination ---

export const ANALYSES_PAGE_SIZES = [25, 50] as const;
export type AnalysesPageSize = (typeof ANALYSES_PAGE_SIZES)[number];
export const DEFAULT_ANALYSES_PAGE_SIZE: AnalysesPageSize = 25;

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** One page (1-indexed) of `items`, `pageSize` at a time. */
export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

// --- URL query-string state ---

export type AnalysesTableState = AnalysesFilterState & {
  sort: AnalysesSortState;
  page: number;
  pageSize: AnalysesPageSize;
};

export const DEFAULT_ANALYSES_TABLE_STATE: AnalysesTableState = {
  ...DEFAULT_ANALYSES_FILTERS,
  sort: DEFAULT_ANALYSES_SORT,
  page: 1,
  pageSize: DEFAULT_ANALYSES_PAGE_SIZE,
};

/** Reads the table's state from the page's URL query string, falling back to
 *  the default for anything missing or invalid — an edited or stale URL never
 *  crashes the page. */
export function parseAnalysesTableState(
  params: URLSearchParams,
): AnalysesTableState {
  const status = params.get("status");
  const cvLabel = params.get("cv");
  const column = params.get("sort");
  const direction = params.get("dir");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));

  return {
    search: params.get("q") ?? DEFAULT_ANALYSES_TABLE_STATE.search,
    status: TRACKING_STATUSES.includes(status as TrackingStatus)
      ? (status as TrackingStatus)
      : "all",
    cvLabel: cvLabel ?? "all",
    sort: {
      column: SORT_COLUMNS.includes(column as AnalysesSortColumn)
        ? (column as AnalysesSortColumn)
        : DEFAULT_ANALYSES_SORT.column,
      direction:
        direction === "asc" || direction === "desc"
          ? direction
          : DEFAULT_ANALYSES_SORT.direction,
    },
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (ANALYSES_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? (pageSize as AnalysesPageSize)
      : DEFAULT_ANALYSES_PAGE_SIZE,
  };
}

/** The inverse of {@link parseAnalysesTableState} — only writes a param when
 *  it differs from the "no filter" default, keeping the URL clean. */
export function analysesTableStateToParams(
  state: AnalysesTableState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (state.status !== "all") params.set("status", state.status);
  if (state.cvLabel !== "all") params.set("cv", state.cvLabel);
  params.set("sort", state.sort.column);
  params.set("dir", state.sort.direction);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
