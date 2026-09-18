"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";

import {
  useAdminPlanDefaults,
  useAdminStats,
  useAdminUserQuotas,
  useAdminUsers,
  useClearQuotaOverride,
  useSetPlanDefault,
  useSetQuotaOverride,
  useSetUserBlocked,
  useSetUserPlan,
  type AdminUserRow,
} from "@/hooks/use-admin";
import {
  ADMIN_USER_PLANS,
  ADMIN_USERS_PAGE_SIZES,
  adminUsersTableStateToParams,
  parseAdminUsersTableState,
  type AdminBooleanFilter,
  type AdminUsersPageSize,
  type AdminUsersSortColumn,
  type AdminUsersTableState,
} from "@/lib/admin-users-filters";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SortableHead } from "@/components/sortable-head";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

const KIND_ORDER = [
  "ACTIVE_SCOUTS",
  "ANALYSES_DAILY",
  "ANALYSES_MONTHLY",
  "DOCUMENTS_DAILY",
] as const;

const PLAN_VALUES = ["FREE", "STANDARD", "PREMIUM", "ADMINISTRATEUR"] as const;

function StatsPanel() {
  const t = useTranslations("admin.users.stats");
  const { data, isPending, isError } = useAdminStats();

  if (isPending) return <p className="text-sm text-muted">{t("loading")}</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  const rows: Array<[string, number]> = [
    [t("totalUsers"), data.totalUsers],
    [t("usersOverLimitCount"), data.usersOverLimitCount],
    [t("analysesRequestedToday"), data.analysesRequestedToday],
    [t("analysesRequestedThisMonth"), data.analysesRequestedThisMonth],
    [t("documentsCreatedToday"), data.documentsCreatedToday],
    [t("activeScoutsTotal"), data.activeScoutsTotal],
  ];

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 py-6 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PlanDefaultRow({ plan, kind, limit }: { plan: string; kind: string; limit: number | null }) {
  const t = useTranslations("admin.users.planDefaults");
  const [draft, setDraft] = useState(limit == null ? "" : String(limit));
  const setDefault = useSetPlanDefault();
  const label = `${plan} / ${kind}`;

  return (
    <div className="flex items-center gap-2">
      <span className="w-56 text-sm">{label}</span>
      <Input
        aria-label={label}
        className="h-8 w-24"
        placeholder={t("unlimitedPlaceholder")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={setDefault.isPending}
        onClick={() =>
          setDefault.mutate({ plan, kind, limit: draft.trim() === "" ? null : Number(draft) })
        }
      >
        {t("save", { label })}
      </Button>
    </div>
  );
}

function PlanDefaultsEditor() {
  const t = useTranslations("admin.users.planDefaults");
  const { data, isPending, isError } = useAdminPlanDefaults();

  if (isPending) return <p className="text-sm text-muted">{t("loading")}</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-6">
        {data.defaults.map((row) => (
          <PlanDefaultRow
            key={`${row.plan}:${row.quotaKind}`}
            plan={row.plan}
            kind={row.quotaKind}
            limit={row.limit}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function OverrideEditor({
  userId,
  kind,
  cap,
  hasOverride,
}: {
  userId: string;
  kind: string;
  cap: number | null;
  hasOverride: boolean;
}) {
  const t = useTranslations("admin.userPanel");
  const [draft, setDraft] = useState(cap == null ? "" : String(cap));
  const setOverride = useSetQuotaOverride(userId);
  const clearOverride = useClearQuotaOverride(userId);

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t("overrideInputLabel", { kind })}
        className="h-8 w-24"
        placeholder={t("unlimitedPlaceholder")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={setOverride.isPending}
        onClick={() =>
          setOverride.mutate({ kind, limit: draft.trim() === "" ? null : Number(draft) })
        }
      >
        {t("setOverride")}
      </Button>
      {hasOverride && (
        <Button
          size="sm"
          variant="ghost"
          disabled={clearOverride.isPending}
          onClick={() => clearOverride.mutate(kind)}
        >
          {t("clearOverride")}
        </Button>
      )}
    </div>
  );
}

/**
 * Block/unblock action (issue #148), shared between the table row's quick
 * action and the User panel — both ask for inline confirmation before
 * applying, and both disable the action for the caller's own row/panel so an
 * Administrator can never block themselves (also enforced server-side).
 */
function BlockUnblockAction({
  userId,
  blocked,
  isSelf,
  onStopPropagation,
}: {
  userId: string;
  blocked: boolean;
  isSelf: boolean;
  onStopPropagation?: boolean;
}) {
  const t = useTranslations("admin.userPanel");
  const [confirming, setConfirming] = useState(false);
  const setBlocked = useSetUserBlocked(userId);

  const stop = (event: { stopPropagation: () => void }) => {
    if (onStopPropagation) event.stopPropagation();
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">
          {blocked ? t("unblockConfirm") : t("blockConfirm")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={setBlocked.isPending}
          onClick={(event) => {
            stop(event);
            setBlocked.mutate(!blocked, { onSuccess: () => setConfirming(false) });
          }}
        >
          {t("confirmAction")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={setBlocked.isPending}
          onClick={(event) => {
            stop(event);
            setConfirming(false);
          }}
        >
          {t("cancelAction")}
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isSelf}
      title={isSelf ? t("selfActionDisabled") : undefined}
      onClick={(event) => {
        stop(event);
        setConfirming(true);
      }}
    >
      {blocked ? t("unblockAction") : t("blockAction")}
    </Button>
  );
}

/**
 * The User panel (issue #147): a slide-over replacing the deleted dedicated
 * per-user page (issue #139), reachable via the `?user=<id>` URL param so it
 * stays shareable. Shows the User's read-only info, lets an Administrator
 * reassign their Plan, and carries forward the per-QuotaKind usage +
 * override controls unchanged from the old page.
 */
function UserPanel({
  userId,
  selfId,
  onClose,
}: {
  userId: string | null;
  selfId: string | undefined;
  onClose: () => void;
}) {
  const t = useTranslations("admin.userPanel");
  const { data, isPending, isError } = useAdminUserQuotas(userId ?? "");
  const setPlan = useSetUserPlan(userId ?? "");

  return (
    <Sheet open={userId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {userId && (
          <>
            <SheetHeader>
              <SheetTitle>{t("title", { userId })}</SheetTitle>
            </SheetHeader>

            {isPending && <p className="text-sm text-muted">{t("loading")}</p>}
            {(isError || (!isPending && !data)) && (
              <p role="alert" className="text-sm text-destructive">
                {t("loadError")}
              </p>
            )}

            {data && (
              <div className="flex flex-col gap-6">
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">{t("infoTitle")}</h2>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted">{t("nameLabel")}</dt>
                    <dd>{data.name ?? t("noName")}</dd>
                    <dt className="text-muted">{t("emailLabel")}</dt>
                    <dd>{data.email ?? t("noName")}</dd>
                    <dt className="text-muted">{t("createdAtLabel")}</dt>
                    <dd>{new Date(data.createdAt).toLocaleDateString()}</dd>
                    <dt className="text-muted">{t("isAdminLabel")}</dt>
                    <dd>{data.isAdmin ? t("yes") : t("no")}</dd>
                    <dt className="text-muted">{t("blockedLabel")}</dt>
                    <dd>{data.blocked ? t("yes") : t("no")}</dd>
                  </dl>
                </section>

                <section className="flex items-center gap-2">
                  <BlockUnblockAction
                    userId={userId}
                    blocked={data.blocked}
                    isSelf={userId === selfId}
                  />
                </section>

                <section className="flex items-center gap-2">
                  <span className="text-sm text-muted">{t("planLabel")}</span>
                  <select
                    className={SELECT_CLASS}
                    aria-label={t("planLabel")}
                    value={data.plan}
                    disabled={setPlan.isPending}
                    onChange={(event) => setPlan.mutate(event.target.value)}
                  >
                    {PLAN_VALUES.map((plan) => (
                      <option key={plan} value={plan}>
                        {plan}
                      </option>
                    ))}
                  </select>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">{t("quotasTitle")}</h2>
                  <div className="flex flex-col gap-5">
                    {KIND_ORDER.map((kind) => {
                      const usage = data.quotas[kind];
                      return (
                        <div key={kind} className="flex flex-col gap-1.5">
                          <p className="text-sm font-medium">{kind}</p>
                          <p className="text-xs text-muted">
                            {usage.cap == null
                              ? t("usageUnlimited", { used: usage.used })
                              : t("usage", {
                                  used: usage.used,
                                  cap: usage.cap,
                                  remaining: usage.remaining ?? 0,
                                })}
                            {usage.hasOverride ? ` · ${t("overrideActive")}` : ""}
                          </p>
                          <OverrideEditor
                            userId={userId}
                            kind={kind}
                            cap={usage.cap}
                            hasOverride={usage.hasOverride}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function UsersTable() {
  const t = useTranslations("admin.users.table");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const selfId = session?.user?.id;

  const state = useMemo(() => parseAdminUsersTableState(searchParams), [searchParams]);
  const openUserId = searchParams.get("user");

  const { data, isPending, isError } = useAdminUsers(state);

  const updateState = (patch: Partial<AdminUsersTableState>) => {
    const next: AdminUsersTableState = { ...state, ...patch, page: patch.page ?? 1 };
    const params = adminUsersTableStateToParams(next);
    if (openUserId) params.set("user", openUserId);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const openUser = (id: string) => {
    const params = adminUsersTableStateToParams(state);
    params.set("user", id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const closeUser = () => {
    const params = adminUsersTableStateToParams(state);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const toggleSort = (column: AdminUsersSortColumn) => {
    updateState({
      sort:
        state.sort.column === column
          ? { column, direction: state.sort.direction === "asc" ? "desc" : "asc" }
          : { column, direction: "asc" },
    });
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-users-search">{t("searchLabel")}</Label>
          <Input
            id="admin-users-search"
            type="search"
            placeholder={t("searchPlaceholder")}
            value={state.search}
            onChange={(event) => updateState({ search: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-users-plan">{t("planLabel")}</Label>
          <select
            id="admin-users-plan"
            className={SELECT_CLASS + " w-full"}
            value={state.plan}
            onChange={(event) =>
              updateState({ plan: event.target.value as AdminUsersTableState["plan"] })
            }
          >
            <option value="all">{t("planAllOption")}</option>
            {ADMIN_USER_PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {plan}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-users-is-admin">{t("adminFilterLabel")}</Label>
          <select
            id="admin-users-is-admin"
            className={SELECT_CLASS + " w-full"}
            value={state.isAdmin}
            onChange={(event) =>
              updateState({ isAdmin: event.target.value as AdminBooleanFilter })
            }
          >
            <option value="all">{t("adminAllOption")}</option>
            <option value="true">{t("adminYesOption")}</option>
            <option value="false">{t("adminNoOption")}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-users-blocked">{t("blockedFilterLabel")}</Label>
          <select
            id="admin-users-blocked"
            className={SELECT_CLASS + " w-full"}
            value={state.blocked}
            onChange={(event) =>
              updateState({ blocked: event.target.value as AdminBooleanFilter })
            }
          >
            <option value="all">{t("blockedAllOption")}</option>
            <option value="true">{t("blockedYesOption")}</option>
            <option value="false">{t("blockedNoOption")}</option>
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={state.atOrOverLimit}
          onChange={(event) => updateState({ atOrOverLimit: event.target.checked })}
          aria-label={t("atOrOverLimitLabel")}
        />
        {t("atOrOverLimitLabel")}
      </label>

      {isPending && <p className="text-sm text-muted">{t("loading")}</p>}
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      )}
      {data && data.users.length === 0 && (
        <p className="text-sm text-muted">{total === 0 ? t("empty") : t("noMatches")}</p>
      )}

      {data && data.users.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead column="name" label={t("columns.name")} sort={state.sort} onSort={toggleSort} />
                <SortableHead column="email" label={t("columns.email")} sort={state.sort} onSort={toggleSort} />
                <SortableHead column="plan" label={t("columns.plan")} sort={state.sort} onSort={toggleSort} />
                <SortableHead column="isAdmin" label={t("columns.isAdmin")} sort={state.sort} onSort={toggleSort} />
                <SortableHead column="blocked" label={t("columns.blocked")} sort={state.sort} onSort={toggleSort} />
                <SortableHead
                  column="createdAt"
                  label={t("columns.createdAt")}
                  sort={state.sort}
                  onSort={toggleSort}
                />
                <TableHead>{t("columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.users.map((user: AdminUserRow) => (
                <TableRow
                  key={user.id}
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => openUser(user.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openUser(user.id);
                    }
                  }}
                >
                  <TableCell className="font-medium">{user.name ?? t("noName")}</TableCell>
                  <TableCell>{user.email ?? t("noEmail")}</TableCell>
                  <TableCell>{user.plan}</TableCell>
                  <TableCell>{user.isAdmin ? t("adminYesOption") : "—"}</TableCell>
                  <TableCell>{user.blocked ? t("blockedYesOption") : "—"}</TableCell>
                  <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <BlockUnblockAction
                      userId={user.id}
                      blocked={user.blocked}
                      isSelf={user.id === selfId}
                      onStopPropagation
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="admin-users-page-size" className="text-sm text-muted">
                {t("pagination.pageSizeLabel")}
              </Label>
              <select
                id="admin-users-page-size"
                className={SELECT_CLASS + " w-auto"}
                value={state.pageSize}
                onChange={(event) =>
                  updateState({ pageSize: Number(event.target.value) as AdminUsersPageSize })
                }
              >
                {ADMIN_USERS_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">
                {t("pagination.pageInfo", { page: state.page, totalPages, total })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.page <= 1}
                onClick={() => updateState({ page: state.page - 1 })}
              >
                {t("pagination.previous")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.page >= totalPages}
                onClick={() => updateState({ page: state.page + 1 })}
              >
                {t("pagination.next")}
              </Button>
            </div>
          </div>
        </>
      )}

      <UserPanel userId={openUserId} selfId={selfId} onClose={closeUser} />
    </div>
  );
}

/**
 * The admin reporting screen (issue #140), whose Users table was rewritten
 * for scale in issue #147: search/filter/sort/pagination all applied
 * server-side, and clicking a row opens the User panel in place via a
 * shareable `?user=<id>` URL param instead of navigating to a dedicated page.
 */
export default function AdminUsersPage() {
  const t = useTranslations("admin.users");

  return (
    <Suspense fallback={null}>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("description")}</p>
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("stats.title")}</h2>
          <StatsPanel />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("planDefaults.title")}</h2>
          <PlanDefaultsEditor />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("table.title")}</h2>
          <UsersTable />
        </section>
      </main>
    </Suspense>
  );
}
