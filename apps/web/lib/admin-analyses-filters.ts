// Pure, framework-free URL <-> state helpers behind the Admin analyses table
// (issue #161). Like the Admin CV versions table (lib/admin-cv-versions-filters.ts)
// and unlike the candidate-facing analyses page, filtering, sorting (fixed:
// newest first) and pagination are NOT applied client-side — this state is
// sent straight through as query params to `GET /v1/admin/analyses`. A
// `status` filter was added in issue #172, mirroring the candidate-facing
// page's own Tracking-status-buckets-plus-FAILED vocabulary — this still
// only narrows which rows list; there is still no status-*transition*
// control here (that stays exclusively the candidate's own `/analyses`).

import { ANALYSES_STATUS_FILTERS, type AnalysesStatusFilter } from "@/lib/tracking-status";

export const ADMIN_ANALYSES_PAGE_SIZES = [20, 50] as const;
export type AdminAnalysesPageSize = (typeof ADMIN_ANALYSES_PAGE_SIZES)[number];

export type AdminAnalysesTableState = {
  /** A candidate's userId, resolved via the CandidatePicker's type-ahead, or
   *  `null` for no candidate filter. */
  userId: string | null;
  /** The CandidatePicker input's display text — kept separate from `userId`
   *  so it survives a page refresh even though it plays no part in the
   *  actual server-side filter. */
  candidateQuery: string;
  /** A Tracking status bucket, or `FAILED` (issue #172), or `null` for no
   *  status filter. */
  status: AnalysesStatusFilter | null;
  /** `requestedAt` range, as `YYYY-MM-DD` date-input strings, or `""` for no
   *  bound on that side. */
  requestedAtFrom: string;
  requestedAtTo: string;
  page: number;
  pageSize: AdminAnalysesPageSize;
};

export const DEFAULT_ADMIN_ANALYSES_TABLE_STATE: AdminAnalysesTableState = {
  userId: null,
  candidateQuery: "",
  status: null,
  requestedAtFrom: "",
  requestedAtTo: "",
  page: 1,
  pageSize: 20,
};

/** Reads the table's state from the page's URL query string, falling back to
 *  the default for anything missing or invalid — an edited or stale URL never
 *  crashes the page. */
export function parseAdminAnalysesTableState(
  params: URLSearchParams,
): AdminAnalysesTableState {
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  const userId = params.get("userId");
  const status = params.get("status");

  return {
    userId: userId && userId !== "" ? userId : null,
    candidateQuery: params.get("candidateQuery") ?? "",
    status: ANALYSES_STATUS_FILTERS.includes(status as AnalysesStatusFilter)
      ? (status as AnalysesStatusFilter)
      : null,
    requestedAtFrom: params.get("from") ?? "",
    requestedAtTo: params.get("to") ?? "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (ADMIN_ANALYSES_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? (pageSize as AdminAnalysesPageSize)
      : DEFAULT_ADMIN_ANALYSES_TABLE_STATE.pageSize,
  };
}

/** The inverse of {@link parseAdminAnalysesTableState} — only writes a param
 *  when it differs from the "no filter" default, keeping the URL clean. */
export function adminAnalysesTableStateToParams(
  state: AdminAnalysesTableState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.candidateQuery) params.set("candidateQuery", state.candidateQuery);
  if (state.status) params.set("status", state.status);
  if (state.requestedAtFrom) params.set("from", state.requestedAtFrom);
  if (state.requestedAtTo) params.set("to", state.requestedAtTo);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}

/** The query string sent to `GET /v1/admin/analyses` (via the BFF route) for
 *  this table state — `requestedAtFrom`/`requestedAtTo` are widened to cover
 *  the whole named day since the endpoint takes full timestamps, not bare
 *  dates. `status` passes straight through: the backend's
 *  `AdminAnalysesStatusFilter` uses the exact same values. */
export function adminAnalysesTableStateToQuery(
  state: AdminAnalysesTableState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.status) params.set("status", state.status);
  if (state.requestedAtFrom) {
    params.set("requestedAtFrom", `${state.requestedAtFrom}T00:00:00.000Z`);
  }
  if (state.requestedAtTo) {
    params.set("requestedAtTo", `${state.requestedAtTo}T23:59:59.999Z`);
  }
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
