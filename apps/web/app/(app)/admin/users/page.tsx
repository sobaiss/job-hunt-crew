"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Eraser,
  LoaderCircle,
  Pencil,
  Save,
  X,
} from "lucide-react";

import {
  useAdminAuditEvents,
  useAdminUserQuotas,
  useAdminUsers,
  useClearQuotaOverride,
  useSetQuotaOverride,
  useSetUserRole,
  useSetUserBlocked,
  useSetUserInfo,
  useSetUserPlan,
  type AdminUserRow,
} from "@/hooks/use-admin";
import {
  ADMIN_USER_PLANS,
  ADMIN_USER_ROLES,
  ADMIN_USERS_PAGE_SIZES,
  adminUsersTableStateToParams,
  parseAdminUsersTableState,
  type AdminBooleanFilter,
  type AdminUserRoleFilter,
  type AdminUsersPageSize,
  type AdminUsersSortColumn,
  type AdminUsersTableState,
} from "@/lib/admin-users-filters";
import { useEnumLabel } from "@/lib/enum-labels";
import type { ColumnConfig } from "@/lib/column-visibility";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { CandidatePicker } from "@/components/candidate-picker";
import { CopyIdButton } from "@/components/copy-id-button";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SortableHead } from "@/components/sortable-head";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

// Name is the always-visible primary column; id is hideable and hidden by
// default, mirroring the other Admin tables (analyses/scouts/cv-versions).
// Plan and id aren't part of AdminUsersSortColumn (no server-side sort for
// either), so they render as plain TableHead while the rest keep using
// SortableHead — this only adds show/hide, it doesn't add new sort columns.
type AdminUsersColumn = "name" | "id" | "email" | "plan" | "role" | "blocked" | "createdAt";

const COLUMNS: ColumnConfig<AdminUsersColumn>[] = [
  { key: "name", labelKey: "columns.name", hideable: false },
  { key: "id", labelKey: "columns.id", hideable: true, defaultVisible: false },
  { key: "email", labelKey: "columns.email", hideable: true },
  { key: "plan", labelKey: "columns.plan", hideable: true },
  { key: "role", labelKey: "columns.role", hideable: true },
  { key: "blocked", labelKey: "columns.blocked", hideable: true },
  { key: "createdAt", labelKey: "columns.createdAt", hideable: true },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:admin-users";

const KIND_ORDER = [
  "ACTIVE_SCOUTS",
  "ANALYSES_DAILY",
  "ANALYSES_MONTHLY",
  "DOCUMENTS_DAILY",
] as const;

// The three Plans a Subscription can be assigned (issue #155, docs/adr/0018).
const ASSIGNABLE_PLAN_VALUES = ["FREE", "STANDARD", "PREMIUM"] as const;
const DURATION_VALUES = ["MONTHLY", "YEARLY"] as const;

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
  const quotaKindLabel = useEnumLabel("quotaKind");
  const [draft, setDraft] = useState(cap == null ? "" : String(cap));
  const setOverride = useSetQuotaOverride(userId);
  const clearOverride = useClearQuotaOverride(userId);

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t("overrideInputLabel", { kind: quotaKindLabel(kind) })}
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
        <Save aria-hidden="true" />
        {t("setOverride")}
      </Button>
      {hasOverride && (
        <Button
          size="sm"
          variant="ghost"
          disabled={clearOverride.isPending}
          onClick={() => clearOverride.mutate(kind)}
        >
          <Eraser aria-hidden="true" />
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
        {/* Confirming a block is the destructive half; confirming an unblock
            gives access back, so it stays an ordinary primary action. */}
        <Button
          type="button"
          variant={blocked ? "default" : "destructive"}
          size="sm"
          disabled={setBlocked.isPending}
          onClick={(event) => {
            stop(event);
            setBlocked.mutate(!blocked, { onSuccess: () => setConfirming(false) });
          }}
        >
          {setBlocked.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {t("confirmAction")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={setBlocked.isPending}
          onClick={(event) => {
            stop(event);
            setConfirming(false);
          }}
        >
          <X aria-hidden="true" />
          {t("cancelAction")}
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant={blocked ? "outline" : "destructive-ghost"}
      size="sm"
      disabled={isSelf}
      title={isSelf ? t("selfActionDisabled") : undefined}
      onClick={(event) => {
        stop(event);
        setConfirming(true);
      }}
    >
      {blocked ? (
        <CircleCheck aria-hidden="true" />
      ) : (
        <Ban aria-hidden="true" />
      )}
      {blocked ? t("unblockAction") : t("blockAction")}
    </Button>
  );
}

/**
 * Inline name editor (issue #149) — email stays read-only next to it, and is
 * never sent by this component's mutation.
 */
function NameEditor({ userId, name }: { userId: string; name: string | null }) {
  const t = useTranslations("admin.userPanel");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const setInfo = useSetUserInfo(userId);

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span>{name ?? t("noName")}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(name ?? "");
            setEditing(true);
          }}
        >
          <Pencil aria-hidden="true" />
          {t("editNameAction")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t("nameLabel")}
        className="h-8 w-48"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={setInfo.isPending || draft.trim() === ""}
        onClick={() =>
          setInfo.mutate(draft.trim(), { onSuccess: () => setEditing(false) })
        }
      >
        {setInfo.isPending ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <Save aria-hidden="true" />
        )}
        {t("saveNameAction")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
        <X aria-hidden="true" />
        {t("cancelAction")}
      </Button>
    </div>
  );
}

/**
 * Three-way Role select (issue #156, replacing the isAdmin grant/revoke
 * toggle from #149 per docs/adr/0017) — picking a different Role asks for
 * inline confirmation before submitting, mirroring BlockUnblockAction's
 * confirm shape. Disabled for the caller's own row: changing their own Role
 * away from Administrator is rejected server-side (it would lock them out of
 * the Admin area with no way back in), so the whole select is disabled for a
 * self-target rather than only that one direction.
 */
function RoleEditor({
  userId,
  role,
  isSelf,
}: {
  userId: string;
  role: string;
  isSelf: boolean;
}) {
  const t = useTranslations("admin.userPanel");
  const roleLabel = useEnumLabel("role");
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const setRole = useSetUserRole(userId);

  if (pendingRole !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">
          {t("roleConfirm", { role: roleLabel(pendingRole) })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={setRole.isPending}
          onClick={() =>
            setRole.mutate(pendingRole, { onSuccess: () => setPendingRole(null) })
          }
        >
          {setRole.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {t("confirmAction")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={setRole.isPending}
          onClick={() => setPendingRole(null)}
        >
          <X aria-hidden="true" />
          {t("cancelAction")}
        </Button>
      </div>
    );
  }

  return (
    <select
      className={SELECT_CLASS}
      aria-label={t("roleLabel")}
      value={role}
      disabled={isSelf}
      title={isSelf ? t("selfRoleActionDisabled") : undefined}
      onChange={(event) => setPendingRole(event.target.value)}
    >
      {ADMIN_USER_ROLES.map((value) => (
        <option key={value} value={value}>
          {roleLabel(value)}
        </option>
      ))}
    </select>
  );
}

/**
 * Assigns/renews a User's Subscription (issue #155, docs/adr/0018) — a
 * duration is required once Standard/Premium is picked (hidden/disabled for
 * Free, whose Subscription is always unbounded), and both are only sent to
 * the server together via the explicit action button, not on every keystroke
 * the way the old single-select Plan reassignment worked.
 */
function PlanEditor({
  userId,
  plan,
  planEndDate,
}: {
  userId: string;
  plan: string;
  planEndDate: string | null;
}) {
  const t = useTranslations("admin.userPanel");
  const [planDraft, setPlanDraft] = useState(plan);
  const [durationDraft, setDurationDraft] = useState<string>("");
  const setPlan = useSetUserPlan(userId);
  const needsDuration = planDraft === "STANDARD" || planDraft === "PREMIUM";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          className={SELECT_CLASS}
          aria-label={t("planLabel")}
          value={planDraft}
          disabled={setPlan.isPending}
          onChange={(event) => {
            setPlanDraft(event.target.value);
            setDurationDraft("");
          }}
        >
          {ASSIGNABLE_PLAN_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        {needsDuration && (
          <select
            className={SELECT_CLASS}
            aria-label={t("durationLabel")}
            value={durationDraft}
            disabled={setPlan.isPending}
            onChange={(event) => setDurationDraft(event.target.value)}
          >
            <option value="">{t("durationPlaceholder")}</option>
            {DURATION_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(`duration.${value}`)}
              </option>
            ))}
          </select>
        )}

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={setPlan.isPending || (needsDuration && durationDraft === "")}
          onClick={() =>
            setPlan.mutate({
              plan: planDraft,
              duration: needsDuration ? durationDraft : null,
            })
          }
        >
          {setPlan.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {t("assignPlanAction")}
        </Button>
      </div>
      {planEndDate && (
        <p className="text-xs text-muted">
          {t("planEndDateLabel", { date: new Date(planEndDate).toLocaleDateString() })}
        </p>
      )}
    </div>
  );
}

function AuditHistory({ userId }: { userId: string }) {
  const t = useTranslations("admin.userPanel");
  const { data, isPending, isError } = useAdminAuditEvents(userId);

  if (isPending) return <p className="text-sm text-muted">{t("auditLoading")}</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("auditLoadError")}
      </p>
    );
  }
  if (data.events.length === 0) {
    return <p className="text-sm text-muted">{t("auditEmpty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {data.events.map((event) => (
        <li key={event.id} className="flex flex-col gap-0.5 rounded-md border border-border p-3 text-sm">
          <p className="font-medium">{event.field}</p>
          <p className="text-muted">
            {t("auditOldToNew", {
              oldValue: event.oldValue ?? t("auditNullValue"),
              newValue: event.newValue ?? t("auditNullValue"),
            })}
          </p>
          <p className="text-xs text-muted">
            {t("auditByAt", {
              actor: event.actor.name ?? event.actor.email ?? event.actor.id,
              date: new Date(event.createdAt).toLocaleString(),
            })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The User panel (issue #147): a slide-over replacing the deleted dedicated
 * per-user page (issue #139), reachable via the `?user=<id>` URL param so it
 * stays shareable. Shows the User's read-only info, lets an Administrator
 * reassign their Plan, and carries forward the per-QuotaKind usage +
 * override controls unchanged from the old page. Issue #150 adds an Audit
 * history tab alongside the existing Details content.
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
  const quotaKindLabel = useEnumLabel("quotaKind");
  const roleLabel = useEnumLabel("role");
  const { data, isPending, isError } = useAdminUserQuotas(userId ?? "");

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
              <Tabs defaultValue="details">
                <TabsList>
                  <TabsTrigger value="details">{t("detailsTab")}</TabsTrigger>
                  <TabsTrigger value="history">{t("historyTab")}</TabsTrigger>
                </TabsList>

                <TabsContent value="details">
                  <div className="flex flex-col gap-6">
                    <section className="flex flex-col gap-2">
                      <h2 className="text-sm font-semibold">{t("infoTitle")}</h2>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted">{t("nameLabel")}</dt>
                        <dd>
                          <NameEditor userId={userId} name={data.name} />
                        </dd>
                        <dt className="text-muted">{t("emailLabel")}</dt>
                        <dd>{data.email ?? t("noName")}</dd>
                        <dt className="text-muted">{t("createdAtLabel")}</dt>
                        <dd>{new Date(data.createdAt).toLocaleDateString()}</dd>
                        <dt className="text-muted">{t("roleLabel")}</dt>
                        <dd>{roleLabel(data.role)}</dd>
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
                      <RoleEditor userId={userId} role={data.role} isSelf={userId === selfId} />
                    </section>

                    <section className="flex flex-col gap-2">
                      <span className="text-sm text-muted">{t("planLabel")}</span>
                      <PlanEditor userId={userId} plan={data.plan} planEndDate={data.planEndDate} />
                    </section>

                    <section className="flex flex-col gap-2">
                      <h2 className="text-sm font-semibold">{t("quotasTitle")}</h2>
                      <div className="flex flex-col gap-5">
                        {KIND_ORDER.map((kind) => {
                          const usage = data.quotas[kind];
                          return (
                            <div key={kind} className="flex flex-col gap-1.5">
                              <p className="text-sm font-medium">{quotaKindLabel(kind)}</p>
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
                </TabsContent>

                <TabsContent value="history">
                  <AuditHistory userId={userId} />
                </TabsContent>
              </Tabs>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function UsersTable() {
  const t = useTranslations("admin.users.table");
  const roleLabel = useEnumLabel("role");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const selfId = session?.user?.id;

  const state = useMemo(() => parseAdminUsersTableState(searchParams), [searchParams]);
  const openUserId = searchParams.get("user");

  const { data, isPending, isError } = useAdminUsers(state);
  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);

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
        <CandidatePicker
          id="admin-users-search"
          label={t("searchLabel")}
          placeholder={t("searchPlaceholder")}
          value={state.search}
          onChange={(search) => updateState({ search })}
        />

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
          <Label htmlFor="admin-users-role">{t("roleFilterLabel")}</Label>
          <select
            id="admin-users-role"
            className={SELECT_CLASS + " w-full"}
            value={state.role}
            onChange={(event) =>
              updateState({ role: event.target.value as AdminUserRoleFilter })
            }
          >
            <option value="all">{t("roleAllOption")}</option>
            {ADMIN_USER_ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
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

      <div className="flex items-center justify-between gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.atOrOverLimit}
            onChange={(event) => updateState({ atOrOverLimit: event.target.checked })}
            aria-label={t("atOrOverLimitLabel")}
          />
          {t("atOrOverLimitLabel")}
        </label>
        <ColumnVisibilityMenu
          columns={COLUMNS}
          isVisible={columnVisibility.isVisible}
          onToggle={columnVisibility.toggle}
          onReset={columnVisibility.reset}
          label={t("columnsLabel")}
          columnLabel={(labelKey) => t(labelKey)}
          resetLabel={t("columnsReset")}
        />
      </div>

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
                {columnVisibility.isVisible("id") && <TableHead>{t("columns.id")}</TableHead>}
                {columnVisibility.isVisible("email") && (
                  <SortableHead column="email" label={t("columns.email")} sort={state.sort} onSort={toggleSort} />
                )}
                {columnVisibility.isVisible("plan") && <TableHead>{t("columns.plan")}</TableHead>}
                {columnVisibility.isVisible("role") && (
                  <SortableHead column="role" label={t("columns.role")} sort={state.sort} onSort={toggleSort} />
                )}
                {columnVisibility.isVisible("blocked") && (
                  <SortableHead column="blocked" label={t("columns.blocked")} sort={state.sort} onSort={toggleSort} />
                )}
                {columnVisibility.isVisible("createdAt") && (
                  <SortableHead
                    column="createdAt"
                    label={t("columns.createdAt")}
                    sort={state.sort}
                    onSort={toggleSort}
                  />
                )}
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
                  {columnVisibility.isVisible("id") && (
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-xs text-muted">{user.id}</span>
                        <CopyIdButton value={user.id} label={t("columns.copyId")} />
                      </div>
                    </TableCell>
                  )}
                  {columnVisibility.isVisible("email") && (
                    <TableCell>{user.email ?? t("noEmail")}</TableCell>
                  )}
                  {columnVisibility.isVisible("plan") && <TableCell>{user.plan}</TableCell>}
                  {columnVisibility.isVisible("role") && <TableCell>{roleLabel(user.role)}</TableCell>}
                  {columnVisibility.isVisible("blocked") && (
                    <TableCell>{user.blocked ? t("blockedYesOption") : "—"}</TableCell>
                  )}
                  {columnVisibility.isVisible("createdAt") && (
                    <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
                  )}
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
                <ChevronLeft aria-hidden="true" />
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
                <ChevronRight aria-hidden="true" />
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
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
        {/* The table is the whole page, so it takes the page's own heading
            rather than repeating it as a section title of its own. */}
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <UsersTable />
      </main>
    </Suspense>
  );
}
