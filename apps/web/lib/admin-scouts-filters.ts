// Pure, framework-free URL <-> state helpers behind the Admin scouts table
// (issue #162). Like the Admin CV versions table (lib/admin-cv-versions-filters.ts)
// and unlike the candidate-facing scouts page, filtering, sorting (fixed:
// newest-created first) and pagination are NOT applied client-side — this
// state is sent straight through as query params to `GET /v1/admin/scouts`.

export const ADMIN_SCOUT_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type AdminScoutStatusFilter = (typeof ADMIN_SCOUT_STATUSES)[number] | "all";

export const ADMIN_SCOUTS_PAGE_SIZES = [20, 50] as const;
export type AdminScoutsPageSize = (typeof ADMIN_SCOUTS_PAGE_SIZES)[number];

export type AdminScoutsTableState = {
  /** A candidate's userId, resolved via the CandidatePicker's type-ahead, or
   *  `null` for no candidate filter. */
  userId: string | null;
  /** The CandidatePicker input's display text — kept separate from `userId`
   *  so it survives a page refresh even though it plays no part in the
   *  actual server-side filter. */
  candidateQuery: string;
  /** `lastRunAt` range, as `YYYY-MM-DD` date-input strings, or `""` for no
   *  bound on that side. */
  lastRunAtFrom: string;
  lastRunAtTo: string;
  status: AdminScoutStatusFilter;
  page: number;
  pageSize: AdminScoutsPageSize;
};

export const DEFAULT_ADMIN_SCOUTS_TABLE_STATE: AdminScoutsTableState = {
  userId: null,
  candidateQuery: "",
  lastRunAtFrom: "",
  lastRunAtTo: "",
  status: "all",
  page: 1,
  pageSize: 20,
};

/** Reads the table's state from the page's URL query string, falling back to
 *  the default for anything missing or invalid — an edited or stale URL never
 *  crashes the page. */
export function parseAdminScoutsTableState(params: URLSearchParams): AdminScoutsTableState {
  const status = params.get("status");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  const userId = params.get("userId");

  return {
    userId: userId && userId !== "" ? userId : null,
    candidateQuery: params.get("candidateQuery") ?? "",
    lastRunAtFrom: params.get("from") ?? "",
    lastRunAtTo: params.get("to") ?? "",
    status: (ADMIN_SCOUT_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as AdminScoutStatusFilter)
      : "all",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (ADMIN_SCOUTS_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? (pageSize as AdminScoutsPageSize)
      : DEFAULT_ADMIN_SCOUTS_TABLE_STATE.pageSize,
  };
}

/** The inverse of {@link parseAdminScoutsTableState} — only writes a param
 *  when it differs from the "no filter" default, keeping the URL clean. */
export function adminScoutsTableStateToParams(state: AdminScoutsTableState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.candidateQuery) params.set("candidateQuery", state.candidateQuery);
  if (state.lastRunAtFrom) params.set("from", state.lastRunAtFrom);
  if (state.lastRunAtTo) params.set("to", state.lastRunAtTo);
  if (state.status !== "all") params.set("status", state.status);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}

/** The query string sent to `GET /v1/admin/scouts` (via the BFF route) for
 *  this table state — `lastRunAtFrom`/`lastRunAtTo` are widened to cover the
 *  whole named day since the endpoint takes full timestamps, not bare
 *  dates. */
export function adminScoutsTableStateToQuery(state: AdminScoutsTableState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.lastRunAtFrom) params.set("lastRunAtFrom", `${state.lastRunAtFrom}T00:00:00.000Z`);
  if (state.lastRunAtTo) params.set("lastRunAtTo", `${state.lastRunAtTo}T23:59:59.999Z`);
  if (state.status !== "all") params.set("status", state.status);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
