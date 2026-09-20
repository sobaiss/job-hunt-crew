"use client";

import { Suspense, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useAdminArchiveScout,
  useAdminPauseScout,
  useAdminResumeScout,
  useAdminRunScout,
  useAdminScouts,
  type AdminScoutRow,
} from "@/hooks/use-admin";
import {
  ADMIN_SCOUT_STATUSES,
  ADMIN_SCOUTS_PAGE_SIZES,
  adminScoutsTableStateToParams,
  parseAdminScoutsTableState,
  type AdminScoutStatusFilter,
  type AdminScoutsPageSize,
  type AdminScoutsTableState,
} from "@/lib/admin-scouts-filters";
import { BffError } from "@/lib/bff-client";
import type { ColumnConfig } from "@/lib/column-visibility";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { CandidatePicker } from "@/components/candidate-picker";
import { CopyIdButton } from "@/components/copy-id-button";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Candidate is the always-visible primary column; id is hideable and hidden
// by default, mirroring the Admin analyses table. Actions stays outside the
// model entirely, same as the candidate-facing tables' own action columns.
type AdminScoutsColumn = "candidate" | "id" | "label" | "status" | "lastRunAt";

const COLUMNS: ColumnConfig<AdminScoutsColumn>[] = [
  { key: "candidate", labelKey: "columns.candidate", hideable: false },
  { key: "id", labelKey: "columns.id", hideable: true, defaultVisible: false },
  { key: "label", labelKey: "columns.label", hideable: true },
  { key: "status", labelKey: "columns.status", hideable: true },
  { key: "lastRunAt", labelKey: "columns.lastRunAt", hideable: true },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:admin-scouts";

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

function statusVariant(status: string): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PAUSED") return "warning";
  return "secondary";
}

/**
 * Row actions (issue #162): Run now, Pause/Resume, Archive — no Edit or
 * Create control anywhere on this page, mirroring the candidate-facing
 * `ScoutPanel`'s own action set minus configuration. Labels are pulled from
 * the existing candidate-facing `scouts` namespace rather than duplicated.
 */
function ScoutRowActions({ row }: { row: AdminScoutRow }) {
  const t = useTranslations("scouts");
  const tRuns = useTranslations("scouts.runs");
  const run = useAdminRunScout();
  const pause = useAdminPauseScout();
  const resume = useAdminResumeScout();
  const archive = useAdminArchiveScout();

  if (row.status === "ARCHIVED") {
    return <span className="text-sm text-muted">—</span>;
  }

  const runErrorMessage =
    run.error instanceof BffError && run.error.status === 429 ? tRuns("rateLimited") : tRuns("runError");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {row.status === "ACTIVE" && (
          <Button type="button" size="sm" disabled={run.isPending} onClick={() => run.mutate(row.id)}>
            {run.isPending ? tRuns("running") : tRuns("runNow")}
          </Button>
        )}
        {row.status === "ACTIVE" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pause.isPending}
            onClick={() => pause.mutate(row.id)}
          >
            {t("actions.pause")}
          </Button>
        )}
        {row.status === "PAUSED" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={resume.isPending}
            onClick={() => resume.mutate(row.id)}
          >
            {t("actions.resume")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={archive.isPending}
          onClick={() => archive.mutate(row.id)}
        >
          {t("actions.archive")}
        </Button>
      </div>
      {run.isError && (
        <p role="alert" className="text-xs text-destructive">
          {runErrorMessage}
        </p>
      )}
      {(pause.isError || resume.isError || archive.isError) && (
        <p role="alert" className="text-xs text-destructive">
          {t("actions.updateError")}
        </p>
      )}
    </div>
  );
}

function ScoutsTable() {
  const t = useTranslations("admin.scouts.table");
  const tScouts = useTranslations("scouts");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => parseAdminScoutsTableState(searchParams), [searchParams]);
  const { data, isPending, isError } = useAdminScouts(state);
  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);

  const updateState = (patch: Partial<AdminScoutsTableState>) => {
    const next: AdminScoutsTableState = { ...state, ...patch, page: patch.page ?? 1 };
    const params = adminScoutsTableStateToParams(next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // CandidatePicker's own click handler calls `onSelectCandidate` and then
  // `onChange` back-to-back, synchronously, before this component re-renders
  // — so both calls close over the same (stale) `state`, and the second
  // `updateState` would otherwise clobber the `userId` the first one just
  // resolved. This ref threads the just-resolved id across that gap.
  const justSelectedUserId = useRef<string | null>(null);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CandidatePicker
          id="admin-scouts-candidate"
          label={t("candidateLabel")}
          placeholder={t("candidatePlaceholder")}
          value={state.candidateQuery}
          onChange={(candidateQuery) => {
            if (justSelectedUserId.current !== null) {
              const userId = justSelectedUserId.current;
              justSelectedUserId.current = null;
              updateState({ candidateQuery, userId });
              return;
            }
            updateState(
              candidateQuery === "" ? { candidateQuery, userId: null } : { candidateQuery },
            );
          }}
          onSelectCandidate={(candidate) => {
            justSelectedUserId.current = candidate.id;
            updateState({
              userId: candidate.id,
              candidateQuery: candidate.name ?? candidate.email ?? candidate.id,
            });
          }}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-scouts-from">{t("lastRunAtFromLabel")}</Label>
          <Input
            id="admin-scouts-from"
            type="date"
            value={state.lastRunAtFrom}
            onChange={(event) => updateState({ lastRunAtFrom: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-scouts-to">{t("lastRunAtToLabel")}</Label>
          <Input
            id="admin-scouts-to"
            type="date"
            value={state.lastRunAtTo}
            onChange={(event) => updateState({ lastRunAtTo: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-scouts-status">{t("statusFilterLabel")}</Label>
          <select
            id="admin-scouts-status"
            className={SELECT_CLASS + " w-full"}
            value={state.status}
            onChange={(event) => updateState({ status: event.target.value as AdminScoutStatusFilter })}
          >
            <option value="all">{t("statusAllOption")}</option>
            {ADMIN_SCOUT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {tScouts(`status.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-end">
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
      {data && data.scouts.length === 0 && (
        <p className="text-sm text-muted">{total === 0 ? t("empty") : t("noMatches")}</p>
      )}

      {data && data.scouts.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.filter((column) => columnVisibility.isVisible(column.key)).map(
                  (column) => (
                    <TableHead key={column.key}>{t(column.labelKey)}</TableHead>
                  ),
                )}
                <TableHead>{t("columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.scouts.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    {row.userName ?? row.userEmail ?? t("noName")}
                  </TableCell>
                  {columnVisibility.isVisible("id") && (
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-xs text-muted">{row.id}</span>
                        <CopyIdButton value={row.id} label={t("columns.copyId")} />
                      </div>
                    </TableCell>
                  )}
                  {columnVisibility.isVisible("label") && <TableCell>{row.label}</TableCell>}
                  {columnVisibility.isVisible("status") && (
                    <TableCell>
                      <Badge variant={statusVariant(row.status)}>{tScouts(`status.${row.status}`)}</Badge>
                    </TableCell>
                  )}
                  {columnVisibility.isVisible("lastRunAt") && (
                    <TableCell>
                      {row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : t("neverRun")}
                    </TableCell>
                  )}
                  <TableCell>
                    <ScoutRowActions row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="admin-scouts-page-size" className="text-sm text-muted">
                {t("pagination.pageSizeLabel")}
              </Label>
              <select
                id="admin-scouts-page-size"
                className={SELECT_CLASS + " w-auto"}
                value={state.pageSize}
                onChange={(event) =>
                  updateState({ pageSize: Number(event.target.value) as AdminScoutsPageSize })
                }
              >
                {ADMIN_SCOUTS_PAGE_SIZES.map((size) => (
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
    </div>
  );
}

/**
 * The Admin scouts table (issue #162): every candidate's Scouts in one
 * server-filtered, paginated table, with Run now / Pause↔Resume / Archive as
 * the only row actions — no Edit or Create control anywhere on this page,
 * since a Scout's configuration and creation stay exclusively the
 * candidate's own.
 */
export default function AdminScoutsPage() {
  const t = useTranslations("admin.scouts");

  return (
    <Suspense fallback={null}>
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("description")}</p>
        </div>

        <section className="flex flex-col gap-2">
          <ScoutsTable />
        </section>
      </main>
    </Suspense>
  );
}
