// Pure, framework-free URL <-> state helpers behind the Admin users table
// (issue #147). Unlike the Analyses table (lib/analyses-filters.ts), search,
// filter, sort and pagination are NOT applied client-side here — this state
// is sent straight through as query params to `GET /v1/admin/users`, which
// applies them server-side, since the table is no longer expected to fit
// unpaginated in one response.

export const ADMIN_USER_PLANS = ["FREE", "STANDARD", "PREMIUM", "ADMINISTRATEUR"] as const;
export type AdminUserPlanFilter = (typeof ADMIN_USER_PLANS)[number] | "all";

export type AdminBooleanFilter = "all" | "true" | "false";

export type AdminUsersSortColumn = "name" | "email" | "plan" | "isAdmin" | "blocked" | "createdAt";
export type AdminUsersSortDirection = "asc" | "desc";

const SORT_COLUMNS: readonly AdminUsersSortColumn[] = [
  "name",
  "email",
  "plan",
  "isAdmin",
  "blocked",
  "createdAt",
];

export type AdminUsersTableState = {
  search: string;
  plan: AdminUserPlanFilter;
  isAdmin: AdminBooleanFilter;
  blocked: AdminBooleanFilter;
  atOrOverLimit: boolean;
  sort: { column: AdminUsersSortColumn; direction: AdminUsersSortDirection };
  page: number;
  pageSize: AdminUsersPageSize;
};

export const ADMIN_USERS_PAGE_SIZES = [20, 50] as const;
export type AdminUsersPageSize = (typeof ADMIN_USERS_PAGE_SIZES)[number];

export const DEFAULT_ADMIN_USERS_TABLE_STATE: AdminUsersTableState = {
  search: "",
  plan: "all",
  isAdmin: "all",
  blocked: "all",
  atOrOverLimit: false,
  sort: { column: "createdAt", direction: "desc" },
  page: 1,
  pageSize: 20,
};

/** Reads the table's state from the page's URL query string, falling back to
 *  the default for anything missing or invalid — an edited or stale URL never
 *  crashes the page. */
export function parseAdminUsersTableState(params: URLSearchParams): AdminUsersTableState {
  const plan = params.get("plan");
  const isAdmin = params.get("isAdmin");
  const blocked = params.get("blocked");
  const column = params.get("sort");
  const direction = params.get("dir");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));

  return {
    search: params.get("q") ?? DEFAULT_ADMIN_USERS_TABLE_STATE.search,
    plan: (ADMIN_USER_PLANS as readonly string[]).includes(plan ?? "")
      ? (plan as AdminUserPlanFilter)
      : "all",
    isAdmin: isAdmin === "true" || isAdmin === "false" ? isAdmin : "all",
    blocked: blocked === "true" || blocked === "false" ? blocked : "all",
    atOrOverLimit: params.get("atOrOverLimit") === "true",
    sort: {
      column: SORT_COLUMNS.includes(column as AdminUsersSortColumn)
        ? (column as AdminUsersSortColumn)
        : DEFAULT_ADMIN_USERS_TABLE_STATE.sort.column,
      direction:
        direction === "asc" || direction === "desc"
          ? direction
          : DEFAULT_ADMIN_USERS_TABLE_STATE.sort.direction,
    },
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (ADMIN_USERS_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? (pageSize as AdminUsersPageSize)
      : DEFAULT_ADMIN_USERS_TABLE_STATE.pageSize,
  };
}

/** The inverse of {@link parseAdminUsersTableState} — only writes a param
 *  when it differs from the "no filter" default, keeping the URL clean. */
export function adminUsersTableStateToParams(state: AdminUsersTableState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  if (state.plan !== "all") params.set("plan", state.plan);
  if (state.isAdmin !== "all") params.set("isAdmin", state.isAdmin);
  if (state.blocked !== "all") params.set("blocked", state.blocked);
  if (state.atOrOverLimit) params.set("atOrOverLimit", "true");
  params.set("sort", state.sort.column);
  params.set("dir", state.sort.direction);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}

/** The query string sent to `GET /v1/admin/users` (via the BFF route) for
 *  this table state — the same fields as the URL state, renamed to the
 *  endpoint's own param names (`q` -> `search`, `dir` -> `sortDir`). */
export function adminUsersTableStateToQuery(state: AdminUsersTableState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search) params.set("search", state.search);
  if (state.plan !== "all") params.set("plan", state.plan);
  if (state.isAdmin !== "all") params.set("isAdmin", state.isAdmin);
  if (state.blocked !== "all") params.set("blocked", state.blocked);
  if (state.atOrOverLimit) params.set("atOrOverLimit", "true");
  params.set("sortBy", state.sort.column);
  params.set("sortDir", state.sort.direction);
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  return params;
}
