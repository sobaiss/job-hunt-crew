import {
  ANALYSES_STATUS_FILTERS,
  type AnalysesStatusFilter,
} from "@/lib/tracking-status";

// Pure, framework-free helpers behind the Analyses table (#63) — now the
// table's *state*, not its data. Search, the status/CVVersion/platform/location
// filters, the sort and the pagination are all applied by `GET /v1/analyses`;
// what lives here is the round trip between that state, the URL query string it
// is kept in (so it survives a refresh and is shareable), and the query string
// the endpoint is asked with. The narrowing itself used to happen here, over a
// list of every Analysis the candidate had; see docs/adr/0033.

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
  /** The Tracking status buckets (plus the pipeline ones, `PENDING` and
   *  `FAILED`) to keep, OR-ed together. Empty means no status filter — and is
   *  still the only way to see one of the other non-terminal pipeline
   *  statuses, since those have no bucket of their own. */
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

// --- Pagination ---

export const ANALYSES_PAGE_SIZES = [25, 50] as const;
export type AnalysesPageSize = (typeof ANALYSES_PAGE_SIZES)[number];
export const DEFAULT_ANALYSES_PAGE_SIZE: AnalysesPageSize = 25;

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
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

/** The query string `GET /api/analyses` is asked with for this table state —
 *  a mirror of `adminAnalysesTableStateToQuery`, down to widening
 *  `requestedAtFrom`/`requestedAtTo` from the date input's bare `YYYY-MM-DD`
 *  to the whole named day, since the endpoint takes full timestamps. Distinct
 *  from {@link analysesTableStateToParams}, which writes the *browser's* URL:
 *  that one keeps the short names a shared link carries (`q`, `cv`,
 *  `requestedFrom`) and omits defaults; this one spells every parameter out
 *  under the endpoint's own names, and is what the query key is built from. */
export function analysesTableStateToQuery(
  state: AnalysesTableState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search.trim()) params.set("q", state.search.trim());
  if (state.status.length > 0) params.set("status", state.status.join(","));
  if (state.cvLabel !== "all") params.set("cv", state.cvLabel);
  if (state.platform.length > 0) params.set("platform", state.platform.join(","));
  if (state.location.trim()) params.set("location", state.location.trim());
  if (state.requestedAtFrom) {
    params.set("requestedAtFrom", `${state.requestedAtFrom}T00:00:00.000Z`);
  }
  if (state.requestedAtTo) {
    params.set("requestedAtTo", `${state.requestedAtTo}T23:59:59.999Z`);
  }
  params.set("sort", state.sort.column);
  params.set("dir", state.sort.direction);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
