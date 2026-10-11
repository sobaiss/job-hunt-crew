import type { Application } from "@/hooks/use-applications";
import { JOB_OFFER_SOURCE_SITES, type JobOfferSourceSite } from "@/lib/analyses-filters";
import {
  TRACKING_STATUSES,
  trackingStatusOfApplication,
  type TrackingStatus,
} from "@/lib/tracking-status";

// Pure, framework-free helpers behind the Applications table (#234), modelled
// on `analyses-filters.ts`. Filtering, sorting and pagination all run
// client-side over the list `/api/applications` already returns; the page
// keeps this state in the URL query string (via `parseApplicationsTableState`
// / `applicationsTableStateToParams`) so it survives a refresh and is
// shareable. Unlike the Analyses table, a default value writes no param at
// all, so an untouched table has a bare `/applications` URL.

/** One row of the Applications table. `location` and `sourceSite` are
 *  optional on the offer because the list endpoint does not send them yet —
 *  a row without them simply matches no location or platform filter. */
export type ApplicationSummary = Omit<Application, "jobOffer"> & {
  jobOffer: Application["jobOffer"] & {
    location?: string | null;
    sourceSite?: string | null;
  };
};

export type ApplicationsFilterState = {
  /** Substring over JobOffer title + company + location, case-insensitive. */
  q: string;
  /** The Tracking status buckets to keep, OR-ed together; empty means no
   *  status filter. */
  status: TrackingStatus[];
  /** `Application.appliedAt` range as `YYYY-MM-DD` date-input strings, or
   *  `""` for no bound on that side. */
  appliedAtFrom: string;
  appliedAtTo: string;
  /** A Scout id, or `"all"` for no Scout filter — a sentinel rather than
   *  `""`, since a Radix Select item cannot carry an empty value. */
  scoutId: string | "all";
  /** The `JobOfferSourceSite`s to keep, OR-ed together; empty means none. */
  sourceSite: JobOfferSourceSite[];
  /** Substring over JobOffer location, case-insensitive. */
  location: string;
};

export const DEFAULT_APPLICATIONS_FILTERS: ApplicationsFilterState = {
  q: "",
  status: [],
  appliedAtFrom: "",
  appliedAtTo: "",
  scoutId: "all",
  sourceSite: [],
  location: "",
};

/** The filters folded away behind the "Plus de filtres" toggle — everything
 *  but the search box and the status select. */
export const ADVANCED_APPLICATIONS_FILTERS = [
  "appliedAtFrom",
  "appliedAtTo",
  "scoutId",
  "sourceSite",
  "location",
] as const satisfies readonly (keyof ApplicationsFilterState)[];

function isFilterSet(
  state: ApplicationsFilterState,
  key: keyof ApplicationsFilterState,
): boolean {
  const value = state[key];
  return Array.isArray(value)
    ? value.length > 0
    : value !== DEFAULT_APPLICATIONS_FILTERS[key];
}

/** How many folded-away *filters* are narrowing the table — filters, not
 *  values, matching `analyses-filters.ts`: two platforms ticked count once. */
export function activeAdvancedFilterCount(state: ApplicationsFilterState): number {
  return ADVANCED_APPLICATIONS_FILTERS.filter((key) => isFilterSet(state, key)).length;
}

/** Any filter at all is set — drives the "Effacer les filtres" reset. */
export function hasActiveFilters(state: ApplicationsFilterState): boolean {
  return (
    isFilterSet(state, "q") ||
    isFilterSet(state, "status") ||
    activeAdvancedFilterCount(state) > 0
  );
}

function includesNeedle(haystack: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle);
}

/** `appliedAt` falls within `[from, to]`, each bare date widened to cover the
 *  whole named day (UTC), as the Analyses `requestedAt` range does. A row
 *  never applied to has no date and drops out as soon as a bound is set. */
function matchesAppliedAtRange(appliedAtIso: string | null, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!appliedAtIso) return false;
  const appliedAt = new Date(appliedAtIso).getTime();
  if (from && appliedAt < new Date(`${from}T00:00:00.000Z`).getTime()) return false;
  if (to && appliedAt > new Date(`${to}T23:59:59.999Z`).getTime()) return false;
  return true;
}

/** Narrow the Applications to those matching every filter. Values inside one
 *  filter are OR-ed, the filters themselves AND-ed. */
export function filterApplications(
  applications: ApplicationSummary[],
  { q, status, appliedAtFrom, appliedAtTo, scoutId, sourceSite, location }: ApplicationsFilterState,
): ApplicationSummary[] {
  return applications.filter((application) => {
    const { jobOffer } = application;
    const offerText = `${jobOffer.title ?? ""} ${jobOffer.company ?? ""} ${jobOffer.location ?? ""}`;
    return (
      includesNeedle(offerText, q) &&
      (status.length === 0 || status.includes(trackingStatusOfApplication(application.status))) &&
      (scoutId === "all" || application.scoutId === scoutId) &&
      (sourceSite.length === 0 ||
        sourceSite.includes(jobOffer.sourceSite as JobOfferSourceSite)) &&
      includesNeedle(jobOffer.location ?? "", location) &&
      matchesAppliedAtRange(application.appliedAt, appliedAtFrom, appliedAtTo)
    );
  });
}

// --- Sorting ---

export type ApplicationsSortField = "appliedAt";
export type ApplicationsSortDirection = "asc" | "desc";

export type ApplicationsSortState = {
  sortField: ApplicationsSortField;
  sortDir: ApplicationsSortDirection;
};

/** Most recent application first. */
export const DEFAULT_APPLICATIONS_SORT: ApplicationsSortState = {
  sortField: "appliedAt",
  sortDir: "desc",
};

/** Sorts by `appliedAt`, compared as ISO-8601 UTC strings. A row never
 *  applied to always sorts last, whichever the direction. */
export function sortApplications(
  applications: ApplicationSummary[],
  { sortField, sortDir }: ApplicationsSortState,
): ApplicationSummary[] {
  const factor = sortDir === "asc" ? 1 : -1;
  return [...applications].sort((a, b) => {
    const va = a[sortField];
    const vb = b[sortField];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return va.localeCompare(vb) * factor;
  });
}

// --- Pagination ---

export const APPLICATIONS_PAGE_SIZES = [25, 50] as const;
export type ApplicationsPageSize = (typeof APPLICATIONS_PAGE_SIZES)[number];
export const DEFAULT_APPLICATIONS_PAGE_SIZE: ApplicationsPageSize = 25;

export function pageCount<T>(items: T[], { pageSize }: { pageSize: number }): number {
  return Math.max(1, Math.ceil(items.length / pageSize));
}

/** One page (1-indexed) of `items`. */
export function paginate<T>(
  items: T[],
  { page, pageSize }: { page: number; pageSize: number },
): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

// --- URL query-string state ---

export type ApplicationsTableState = ApplicationsFilterState &
  ApplicationsSortState & {
    page: number;
    pageSize: ApplicationsPageSize;
  };

export const DEFAULT_APPLICATIONS_TABLE_STATE: ApplicationsTableState = {
  ...DEFAULT_APPLICATIONS_FILTERS,
  ...DEFAULT_APPLICATIONS_SORT,
  page: 1,
  pageSize: DEFAULT_APPLICATIONS_PAGE_SIZE,
};

/** A comma-separated multi-select param, narrowed to the values the filter
 *  offers and de-duplicated; anything unknown is dropped, not rejected. */
function parseMultiParam<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const seen = new Set<T>();
  for (const value of raw.split(",")) {
    if ((allowed as readonly string[]).includes(value)) seen.add(value as T);
  }
  return [...seen];
}

/** Reads the table's state from the URL query string, falling back to the
 *  default for anything missing or invalid. */
export function parseApplicationsTableState(params: URLSearchParams): ApplicationsTableState {
  const defaults = DEFAULT_APPLICATIONS_TABLE_STATE;
  const sortDir = params.get("sortDir");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));

  return {
    q: params.get("q") ?? defaults.q,
    status: parseMultiParam(params.get("status"), TRACKING_STATUSES),
    appliedAtFrom: params.get("appliedAtFrom") ?? defaults.appliedAtFrom,
    appliedAtTo: params.get("appliedAtTo") ?? defaults.appliedAtTo,
    scoutId: params.get("scoutId") || defaults.scoutId,
    sourceSite: parseMultiParam(params.get("sourceSite"), JOB_OFFER_SOURCE_SITES),
    location: params.get("location") ?? defaults.location,
    sortField: defaults.sortField,
    sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : defaults.sortDir,
    page: Number.isInteger(page) && page > 0 ? page : defaults.page,
    pageSize: (APPLICATIONS_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? (pageSize as ApplicationsPageSize)
      : defaults.pageSize,
  };
}

/** The inverse of {@link parseApplicationsTableState} — writes a param only
 *  when it differs from its default. `sortField` has a single value, so it is
 *  never written. */
export function applicationsTableStateToParams(state: ApplicationsTableState): URLSearchParams {
  const defaults = DEFAULT_APPLICATIONS_TABLE_STATE;
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.status.length > 0) params.set("status", state.status.join(","));
  if (state.appliedAtFrom) params.set("appliedAtFrom", state.appliedAtFrom);
  if (state.appliedAtTo) params.set("appliedAtTo", state.appliedAtTo);
  if (state.scoutId !== defaults.scoutId) params.set("scoutId", state.scoutId);
  if (state.sourceSite.length > 0) params.set("sourceSite", state.sourceSite.join(","));
  if (state.location) params.set("location", state.location);
  if (state.sortDir !== defaults.sortDir) params.set("sortDir", state.sortDir);
  if (state.page !== defaults.page) params.set("page", String(state.page));
  if (state.pageSize !== defaults.pageSize) params.set("pageSize", String(state.pageSize));
  return params;
}
