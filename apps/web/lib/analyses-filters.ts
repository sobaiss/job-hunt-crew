import type { AnalysisSummary } from "@/hooks/use-analyses";
import {
  ANALYSES_STATUS_FILTERS,
  trackingStatusOf,
  type AnalysesStatusFilter,
} from "@/lib/tracking-status";

// Pure, framework-free helpers behind the Analyses table (#63). Search, status
// filter and CVVersion filter all operate on the list already returned by
// `/api/analyses` — no new query parameter, no server work. Sorting and
// pagination are likewise applied client-side to that same list. The page
// keeps this state in the URL query string (via `parseAnalysesTableState` /
// `analysesTableStateToParams`) so it survives a refresh and is shareable.

/** Every `JobOfferSourceSite` enum value the platform filter (#125) offers. */
export const JOB_OFFER_SOURCE_SITES = [
  "LINKEDIN",
  "INDEED",
  "FRANCE_TRAVAIL",
  "WTTJ",
  "GLASSDOOR",
  "OTHER",
  "HELLOWORK",
] as const;
export type JobOfferSourceSite = (typeof JOB_OFFER_SOURCE_SITES)[number];

export type AnalysesFilterState = {
  /** Substring over JobOffer title + company, case-insensitive. */
  search: string;
  /** A Tracking status bucket, or `FAILED` (issue #172), or `"all"` for no
   *  status filter — "all" is the only way to see one of the other
   *  non-terminal pipeline statuses, since those have no filter bucket of
   *  their own. */
  status: AnalysesStatusFilter | "all";
  /** A `cvVersion.label`, or `"all"` for no CVVersion filter. */
  cvLabel: string | "all";
  /** A `JobOfferSourceSite`, or `"all"` for no platform filter (#125). */
  platform: JobOfferSourceSite | "all";
  /** Substring over JobOffer location, case-insensitive (#125). */
  location: string;
  /** `Analysis.requestedAt` range, as `YYYY-MM-DD` date-input strings, or
   *  `""` for no bound on that side (issue #172) — mirrors the Admin
   *  analyses table's own `requestedAtFrom`/`requestedAtTo` filter over the
   *  same field. */
  requestedAtFrom: string;
  requestedAtTo: string;
};

export const DEFAULT_ANALYSES_FILTERS: AnalysesFilterState = {
  search: "",
  status: "all",
  cvLabel: "all",
  platform: "all",
  location: "",
  requestedAtFrom: "",
  requestedAtTo: "",
};

/** The filters the Analyses table folds away behind its "Plus de filtres"
 *  toggle — everything but the search box and the status select, which are
 *  the two that earn their permanent place above the table. */
export const ADVANCED_ANALYSES_FILTERS = [
  "requestedAtFrom",
  "requestedAtTo",
  "cvLabel",
  "platform",
  "location",
] as const satisfies readonly (keyof AnalysesFilterState)[];

/** How many of the folded-away filters are set to something other than their
 *  "no filter" default. The toggle shows this count so a filter restored from
 *  the URL is never invisibly narrowing the table from inside a closed panel. */
export function activeAdvancedFilterCount(state: AnalysesFilterState): number {
  return ADVANCED_ANALYSES_FILTERS.filter(
    (key) => state[key] !== DEFAULT_ANALYSES_FILTERS[key],
  ).length;
}

/** Any filter at all is set — drives the "Effacer les filtres" reset, which
 *  covers the visible two as well as the folded-away ones. */
export function hasActiveFilters(state: AnalysesFilterState): boolean {
  return (
    state.search !== DEFAULT_ANALYSES_FILTERS.search ||
    state.status !== DEFAULT_ANALYSES_FILTERS.status ||
    activeAdvancedFilterCount(state) > 0
  );
}

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

function matchesLocation(analysis: AnalysisSummary, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (analysis.jobOffer.location ?? "").toLowerCase().includes(needle);
}

/** `requestedAt` (a full ISO-8601 UTC timestamp) falls within `[from, to]`,
 *  each a bare `YYYY-MM-DD` date-input string widened to cover the whole
 *  named day — mirrors the Admin analyses table's own
 *  `adminAnalysesTableStateToQuery` widening, done server-side there. */
function matchesRequestedAtRange(
  analysis: AnalysisSummary,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  const requestedAt = new Date(analysis.requestedAt).getTime();
  if (from && requestedAt < new Date(`${from}T00:00:00.000Z`).getTime()) return false;
  if (to && requestedAt > new Date(`${to}T23:59:59.999Z`).getTime()) return false;
  return true;
}

/** A status filter matches `FAILED` directly against the Analysis's own
 *  pipeline status, or a Tracking status bucket against `trackingStatusOf` —
 *  mirrors `AdminAnalysesStatusFilter`'s split in `services/api`. */
function matchesStatus(analysis: AnalysisSummary, status: AnalysesStatusFilter): boolean {
  if (status === "FAILED") return analysis.status === "FAILED";
  return trackingStatusOf(analysis) === status;
}

/**
 * Narrow the analyses to those matching the search term, the status filter,
 * the CVVersion filter, the platform filter, the location search (#125) and
 * the `requestedAt` range (#172) — all combined with AND. A specific
 * Tracking status bucket only ever matches a `COMPLETED` Analysis — a
 * still-running one (but not `FAILED`, which has its own bucket now) has no
 * bucket and is excluded from every status filter but `"all"`.
 */
export function filterAnalyses(
  analyses: AnalysisSummary[],
  { search, status, cvLabel, platform, location, requestedAtFrom, requestedAtTo }: AnalysesFilterState,
): AnalysisSummary[] {
  return analyses.filter(
    (analysis) =>
      matchesSearch(analysis, search) &&
      (status === "all" || matchesStatus(analysis, status)) &&
      (cvLabel === "all" || analysis.cvVersion.label === cvLabel) &&
      (platform === "all" || analysis.jobOffer.sourceSite === platform) &&
      matchesLocation(analysis, location) &&
      matchesRequestedAtRange(analysis, requestedAtFrom, requestedAtTo),
  );
}

// --- Sorting ---

/** Every column the table can sort by, matching one field each. */
export type AnalysesSortColumn =
  | "id"
  | "title"
  | "company"
  | "location"
  | "sourceSite"
  | "postedAt"
  | "requestedAt"
  | "cvLabel"
  | "matchScore"
  | "tailoredCvStatus"
  | "coverLetterStatus"
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
  "id",
  "title",
  "company",
  "location",
  "sourceSite",
  "postedAt",
  "requestedAt",
  "cvLabel",
  "matchScore",
  "tailoredCvStatus",
  "coverLetterStatus",
  "sourceUrl",
];

function sortValue(
  analysis: AnalysisSummary,
  column: AnalysesSortColumn,
): string | number | null {
  switch (column) {
    case "id":
      return analysis.id;
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
    case "requestedAt":
      return analysis.requestedAt;
    case "cvLabel":
      return analysis.cvVersion.label;
    case "matchScore":
      return analysis.matchScore;
    case "tailoredCvStatus":
      return analysis.tailoredCvStatus;
    case "coverLetterStatus":
      return analysis.coverLetterStatus;
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
  const platform = params.get("platform");
  const column = params.get("sort");
  const direction = params.get("dir");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));

  return {
    search: params.get("q") ?? DEFAULT_ANALYSES_TABLE_STATE.search,
    status: ANALYSES_STATUS_FILTERS.includes(status as AnalysesStatusFilter)
      ? (status as AnalysesStatusFilter)
      : "all",
    cvLabel: cvLabel ?? "all",
    platform: JOB_OFFER_SOURCE_SITES.includes(platform as JobOfferSourceSite)
      ? (platform as JobOfferSourceSite)
      : "all",
    location: params.get("location") ?? DEFAULT_ANALYSES_TABLE_STATE.location,
    requestedAtFrom:
      params.get("requestedFrom") ?? DEFAULT_ANALYSES_TABLE_STATE.requestedAtFrom,
    requestedAtTo: params.get("requestedTo") ?? DEFAULT_ANALYSES_TABLE_STATE.requestedAtTo,
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
  if (state.platform !== "all") params.set("platform", state.platform);
  if (state.location) params.set("location", state.location);
  if (state.requestedAtFrom) params.set("requestedFrom", state.requestedAtFrom);
  if (state.requestedAtTo) params.set("requestedTo", state.requestedAtTo);
  params.set("sort", state.sort.column);
  params.set("dir", state.sort.direction);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
