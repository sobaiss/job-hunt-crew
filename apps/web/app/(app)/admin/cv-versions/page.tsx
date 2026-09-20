"use client";

import { Suspense, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useAdminCvVersions,
  useReconvertCvVersion,
  type AdminCvVersionRow,
} from "@/hooks/use-admin";
import {
  ADMIN_CV_VERSION_CONVERSION_STATUSES,
  ADMIN_CV_VERSIONS_PAGE_SIZES,
  adminCvVersionsTableStateToParams,
  parseAdminCvVersionsTableState,
  type AdminCvVersionConversionStatusFilter,
  type AdminCvVersionsPageSize,
  type AdminCvVersionsTableState,
} from "@/lib/admin-cv-versions-filters";
import { useEnumLabel } from "@/lib/enum-labels";
import { conversionBadgeVariant } from "@/lib/cv-versions-display";
import type { CvConversionStatus } from "@/hooks/use-cv-versions";
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
// by default, mirroring the Admin analyses/Scouts tables. Actions stays
// outside the model entirely, same as the candidate-facing tables' own
// action columns.
type AdminCvVersionsColumn =
  | "candidate"
  | "id"
  | "label"
  | "fileName"
  | "status"
  | "superseded"
  | "createdAt";

const COLUMNS: ColumnConfig<AdminCvVersionsColumn>[] = [
  { key: "candidate", labelKey: "columns.candidate", hideable: false },
  { key: "id", labelKey: "columns.id", hideable: true, defaultVisible: false },
  { key: "label", labelKey: "columns.label", hideable: true },
  { key: "fileName", labelKey: "columns.fileName", hideable: true },
  { key: "status", labelKey: "columns.status", hideable: true },
  { key: "superseded", labelKey: "columns.superseded", hideable: true },
  { key: "createdAt", labelKey: "columns.createdAt", hideable: true },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:admin-cv-versions";

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Reconvert row action (issue #163) — the only write action this table
 * offers (no Set default/Import/Replace anywhere on this page). Unlike the
 * Admin users table's Block/Role actions, no inline confirmation is asked
 * for, matching the candidate-facing "Convert to Markdown" button's own
 * lack of one.
 */
function ReconvertAction({ cvVersionId }: { cvVersionId: string }) {
  const t = useTranslations("admin.cvVersions.table");
  const reconvert = useReconvertCvVersion();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={reconvert.isPending}
      onClick={() => reconvert.mutate(cvVersionId)}
    >
      {t("reconvertAction")}
    </Button>
  );
}

function CvVersionsTable() {
  const t = useTranslations("admin.cvVersions.table");
  const conversionStatusLabel = useEnumLabel("cvConversionStatus");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => parseAdminCvVersionsTableState(searchParams), [searchParams]);
  const { data, isPending, isError } = useAdminCvVersions(state);
  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);

  const updateState = (patch: Partial<AdminCvVersionsTableState>) => {
    const next: AdminCvVersionsTableState = { ...state, ...patch, page: patch.page ?? 1 };
    const params = adminCvVersionsTableStateToParams(next);
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
          id="admin-cv-versions-candidate"
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
          <Label htmlFor="admin-cv-versions-from">{t("createdAtFromLabel")}</Label>
          <Input
            id="admin-cv-versions-from"
            type="date"
            value={state.createdAtFrom}
            onChange={(event) => updateState({ createdAtFrom: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-cv-versions-to">{t("createdAtToLabel")}</Label>
          <Input
            id="admin-cv-versions-to"
            type="date"
            value={state.createdAtTo}
            onChange={(event) => updateState({ createdAtTo: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-cv-versions-status">{t("statusFilterLabel")}</Label>
          <select
            id="admin-cv-versions-status"
            className={SELECT_CLASS + " w-full"}
            value={state.conversionStatus}
            onChange={(event) =>
              updateState({
                conversionStatus: event.target.value as AdminCvVersionConversionStatusFilter,
              })
            }
          >
            <option value="all">{t("statusAllOption")}</option>
            {ADMIN_CV_VERSION_CONVERSION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {conversionStatusLabel(value)}
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
      {data && data.cvVersions.length === 0 && (
        <p className="text-sm text-muted">{total === 0 ? t("empty") : t("noMatches")}</p>
      )}

      {data && data.cvVersions.length > 0 && (
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
              {data.cvVersions.map((row: AdminCvVersionRow) => (
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
                  {columnVisibility.isVisible("fileName") && <TableCell>{row.fileName}</TableCell>}
                  {columnVisibility.isVisible("status") && (
                    <TableCell>
                      <Badge
                        variant={conversionBadgeVariant(row.conversionStatus as CvConversionStatus)}
                      >
                        {conversionStatusLabel(row.conversionStatus)}
                      </Badge>
                    </TableCell>
                  )}
                  {columnVisibility.isVisible("superseded") && (
                    <TableCell>{row.supersededById ? t("supersededYes") : "—"}</TableCell>
                  )}
                  {columnVisibility.isVisible("createdAt") && (
                    <TableCell>{new Date(row.createdAt).toLocaleDateString()}</TableCell>
                  )}
                  <TableCell>
                    <ReconvertAction cvVersionId={row.id} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="admin-cv-versions-page-size" className="text-sm text-muted">
                {t("pagination.pageSizeLabel")}
              </Label>
              <select
                id="admin-cv-versions-page-size"
                className={SELECT_CLASS + " w-auto"}
                value={state.pageSize}
                onChange={(event) =>
                  updateState({ pageSize: Number(event.target.value) as AdminCvVersionsPageSize })
                }
              >
                {ADMIN_CV_VERSIONS_PAGE_SIZES.map((size) => (
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
 * The Admin CV versions table (issue #163): every candidate's CVVersions in
 * one server-filtered, paginated table, with Reconvert as the only row
 * action — no Set default, Import, or Replace control anywhere on this page,
 * since those stay exclusively the candidate's own to trigger.
 */
export default function AdminCvVersionsPage() {
  const t = useTranslations("admin.cvVersions");

  return (
    <Suspense fallback={null}>
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("description")}</p>
        </div>

        <section className="flex flex-col gap-2">
          <CvVersionsTable />
        </section>
      </main>
    </Suspense>
  );
}
