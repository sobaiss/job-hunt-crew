// Pure, framework-free URL <-> state helpers behind the Admin CV versions
// table (issue #163). Like the Admin users table (lib/admin-users-filters.ts)
// and unlike the candidate-facing cv-versions page, filtering, sorting
// (fixed: newest first) and pagination are NOT applied client-side — this
// state is sent straight through as query params to `GET /v1/admin/cv-versions`.

export const ADMIN_CV_VERSION_CONVERSION_STATUSES = [
  "PENDING",
  "CONVERTING",
  "CONVERTED",
  "FAILED",
] as const;
export type AdminCvVersionConversionStatusFilter =
  | (typeof ADMIN_CV_VERSION_CONVERSION_STATUSES)[number]
  | "all";

export const ADMIN_CV_VERSIONS_PAGE_SIZES = [20, 50] as const;
export type AdminCvVersionsPageSize = (typeof ADMIN_CV_VERSIONS_PAGE_SIZES)[number];

export type AdminCvVersionsTableState = {
  /** A candidate's userId, resolved via the CandidatePicker's type-ahead, or
   *  `null` for no candidate filter. */
  userId: string | null;
  /** The CandidatePicker input's display text — kept separate from `userId`
   *  so it survives a page refresh even though it plays no part in the
   *  actual server-side filter. */
  candidateQuery: string;
  /** `createdAt` range, as `YYYY-MM-DD` date-input strings, or `""` for no
   *  bound on that side. */
  createdAtFrom: string;
  createdAtTo: string;
  conversionStatus: AdminCvVersionConversionStatusFilter;
  page: number;
  pageSize: AdminCvVersionsPageSize;
};

export const DEFAULT_ADMIN_CV_VERSIONS_TABLE_STATE: AdminCvVersionsTableState = {
  userId: null,
  candidateQuery: "",
  createdAtFrom: "",
  createdAtTo: "",
  conversionStatus: "all",
  page: 1,
  pageSize: 20,
};

/** Reads the table's state from the page's URL query string, falling back to
 *  the default for anything missing or invalid — an edited or stale URL never
 *  crashes the page. */
export function parseAdminCvVersionsTableState(
  params: URLSearchParams,
): AdminCvVersionsTableState {
  const status = params.get("status");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  const userId = params.get("userId");

  return {
    userId: userId && userId !== "" ? userId : null,
    candidateQuery: params.get("candidateQuery") ?? "",
    createdAtFrom: params.get("from") ?? "",
    createdAtTo: params.get("to") ?? "",
    conversionStatus: (
      ADMIN_CV_VERSION_CONVERSION_STATUSES as readonly string[]
    ).includes(status ?? "")
      ? (status as AdminCvVersionConversionStatusFilter)
      : "all",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (ADMIN_CV_VERSIONS_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? (pageSize as AdminCvVersionsPageSize)
      : DEFAULT_ADMIN_CV_VERSIONS_TABLE_STATE.pageSize,
  };
}

/** The inverse of {@link parseAdminCvVersionsTableState} — only writes a
 *  param when it differs from the "no filter" default, keeping the URL
 *  clean. */
export function adminCvVersionsTableStateToParams(
  state: AdminCvVersionsTableState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.candidateQuery) params.set("candidateQuery", state.candidateQuery);
  if (state.createdAtFrom) params.set("from", state.createdAtFrom);
  if (state.createdAtTo) params.set("to", state.createdAtTo);
  if (state.conversionStatus !== "all") params.set("status", state.conversionStatus);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}

/** The query string sent to `GET /v1/admin/cv-versions` (via the BFF route)
 *  for this table state — `createdAtFrom`/`createdAtTo` are widened to cover
 *  the whole named day since the endpoint takes full timestamps, not bare
 *  dates. */
export function adminCvVersionsTableStateToQuery(
  state: AdminCvVersionsTableState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.createdAtFrom) params.set("createdAtFrom", `${state.createdAtFrom}T00:00:00.000Z`);
  if (state.createdAtTo) params.set("createdAtTo", `${state.createdAtTo}T23:59:59.999Z`);
  if (state.conversionStatus !== "all") params.set("conversionStatus", state.conversionStatus);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
