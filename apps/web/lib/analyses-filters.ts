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
  /** The Tracking status buckets (plus `FAILED`, issue #172) to keep, OR-ed
   *  together. Empty means no status filter — and is still the only way to
   *  see one of the other non-terminal pipeline statuses, since those have
   *  no bucket of their own. */
  status: AnalysesStatusFilter[];
  /** A `cvVersion.label`, or `"all"` for no CVVersion filter. */
  cvLabel: string | "all";
  /** The `JobOfferSourceSite`s to keep (#125), OR-ed together; empty means
   *  no platform filter. */
  platform: JobOfferSourceSite[];
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
  status: [],
  cvLabel: "all",
  platform: [],
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

/** Whether one filter is narrowing the table at all. A multi-select filter
 *  (status, platform) is set once it holds a value; the rest compare against
 *  their own "no filter" default. */
function isFilterSet(
  state: AnalysesFilterState,
  key: keyof AnalysesFilterState,
): boolean {
  const value = state[key];
  return Array.isArray(value)
    ? value.length > 0
    : value !== DEFAULT_ANALYSES_FILTERS[key];
}

/** How many of the folded-away *filters* are narrowing the table — filters,
 *  not values: two platforms ticked still count as one, because the number
 *  answers "how much is hidden inside this closed panel". The toggle shows it
 *  so a filter restored from the URL is never invisibly narrowing the table
 *  from behind a fold. */
export function activeAdvancedFilterCount(state: AnalysesFilterState): number {
  return ADVANCED_ANALYSES_FILTERS.filter((key) => isFilterSet(state, key)).length;
}

/** Any filter at all is set — drives the "Effacer les filtres" reset, which
 *  covers the visible two as well as the folded-away ones. */
export function hasActiveFilters(state: AnalysesFilterState): boolean {
  return (
    isFilterSet(state, "search") ||
    isFilterSet(state, "status") ||
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
 * the `requestedAt` range (#172). Values inside one filter are OR-ed, the
 * filters themselves AND-ed. A specific Tracking status bucket only ever
 * matches a `COMPLETED` Analysis — a still-running one (but not `FAILED`,
 * which has its own bucket now) has no bucket and is excluded by any
 * non-empty status filter.
 */
export function filterAnalyses(
  analyses: AnalysisSummary[],
  { search, status, cvLabel, platform, location, requestedAtFrom, requestedAtTo }: AnalysesFilterState,
): AnalysisSummary[] {
  return analyses.filter(
    (analysis) =>
      matchesSearch(analysis, search) &&
      (status.length === 0 ||
        status.some((bucket) => matchesStatus(analysis, bucket))) &&
      (cvLabel === "all" || analysis.cvVersion.label === cvLabel) &&
      (platform.length === 0 ||
        platform.includes(analysis.jobOffer.sourceSite as JobOfferSourceSite)) &&
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
/** A comma-separated multi-select param, narrowed to the values the filter
 *  actually offers and de-duplicated. Anything unknown is dropped rather than
 *  rejected — an edited, stale or hand-written URL narrows by what it got
 *  right instead of crashing — and a bare single value (every link minted
 *  before these filters went multiple) parses as a one-element selection. */
function parseMultiParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T[] {
  if (!raw) return [];
  const seen = new Set<T>();
  for (const value of raw.split(",")) {
    if ((allowed as readonly string[]).includes(value)) seen.add(value as T);
  }
  return [...seen];
}

export function parseAnalysesTableState(
  params: URLSearchParams,
): AnalysesTableState {
  const cvLabel = params.get("cv");
  const column = params.get("sort");
  const direction = params.get("dir");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));

  return {
    search: params.get("q") ?? DEFAULT_ANALYSES_TABLE_STATE.search,
    status: parseMultiParam(params.get("status"), ANALYSES_STATUS_FILTERS),
    cvLabel: cvLabel ?? "all",
    platform: parseMultiParam(params.get("platform"), JOB_OFFER_SOURCE_SITES),
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
  if (state.status.length > 0) params.set("status", state.status.join(","));
  if (state.cvLabel !== "all") params.set("cv", state.cvLabel);
  if (state.platform.length > 0) params.set("platform", state.platform.join(","));
  if (state.location) params.set("location", state.location);
  if (state.requestedAtFrom) params.set("requestedFrom", state.requestedAtFrom);
  if (state.requestedAtTo) params.set("requestedTo", state.requestedAtTo);
  params.set("sort", state.sort.column);
  params.set("dir", state.sort.direction);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
