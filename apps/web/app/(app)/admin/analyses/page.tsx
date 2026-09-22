"use client";

import { Suspense, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, RotateCw, Sparkles } from "lucide-react";

import {
  useAdminAnalyses,
  useGenerateAnalysisDocuments,
  useRetryAnalysis,
  type AdminAnalysisRow,
} from "@/hooks/use-admin";
import {
  ADMIN_ANALYSES_PAGE_SIZES,
  adminAnalysesTableStateToParams,
  parseAdminAnalysesTableState,
  type AdminAnalysesPageSize,
  type AdminAnalysesTableState,
} from "@/lib/admin-analyses-filters";
import { useEnumLabel } from "@/lib/enum-labels";
import {
  ANALYSES_STATUS_FILTERS,
  trackingStatusBadgeVariant,
  trackingStatusOf,
} from "@/lib/tracking-status";
import type { ColumnConfig } from "@/lib/column-visibility";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { analysisBadgeVariant } from "@/components/analysis-row";
import type { AnalysisStatus } from "@/hooks/use-analyses";
import type { ApplicationStatus } from "@/hooks/use-applications";
import { CandidatePicker } from "@/components/candidate-picker";
import { CopyIdButton } from "@/components/copy-id-button";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// The candidate is the always-visible primary column, mirroring the
// candidate-facing tables' Label/Position convention; id is hideable and
// hidden by default (a support-ticket lookup, not a browsing column), same
// as the Analyses/Scouts/CV versions Columns menu (#129/#130/#131).
// Actions stays outside the model entirely, like those tables' own
// selection/action columns.
type AdminAnalysesColumn = "candidate" | "id" | "jobOffer" | "status" | "requestedAt";

const COLUMNS: ColumnConfig<AdminAnalysesColumn>[] = [
  { key: "candidate", labelKey: "columns.candidate", hideable: false },
  { key: "id", labelKey: "columns.id", hideable: true, defaultVisible: false },
  { key: "jobOffer", labelKey: "columns.jobOffer", hideable: true },
  { key: "status", labelKey: "columns.status", hideable: true },
  { key: "requestedAt", labelKey: "columns.requestedAt", hideable: true },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:admin-analyses";

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The read-only Tracking-status badge (issue #161) — no status-transition
 * control anywhere on this page, mirroring the candidate-facing page's own
 * `TrackingBadge` (app/(app)/analyses/page.tsx) over the row shape this
 * table's endpoint returns.
 */
function TrackingBadge({
  row,
  pipelineStatusLabel,
  trackingStatusLabel,
}: {
  row: AdminAnalysisRow;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
}) {
  const tracking = trackingStatusOf({
    status: row.status as AnalysisStatus,
    applicationStatus: row.applicationStatus as ApplicationStatus | null,
  });
  return tracking !== null ? (
    <Badge variant={trackingStatusBadgeVariant(tracking)}>{trackingStatusLabel(tracking)}</Badge>
  ) : (
    <Badge variant={analysisBadgeVariant(row.status as AnalysisStatus)}>
      {pipelineStatusLabel(row.status)}
    </Badge>
  );
}

/**
 * Row actions (issue #161): Re-run and Generate documents — no
 * status-transition buttons anywhere on this page (that stays exclusively
 * the candidate's own to change via their own `/analyses` page).
 */
function AnalysisRowActions({ row }: { row: AdminAnalysisRow }) {
  const t = useTranslations("admin.analyses.table");
  const retry = useRetryAnalysis();
  const generateDocuments = useGenerateAnalysisDocuments();

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={retry.isPending}
        onClick={() => retry.mutate(row.id)}
      >
        <RotateCw aria-hidden="true" />
        {t("retryAction")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={generateDocuments.isPending || row.status !== "COMPLETED"}
        onClick={() => generateDocuments.mutate(row.id)}
      >
        <Sparkles aria-hidden="true" />
        {t("generateDocumentsAction")}
      </Button>
    </div>
  );
}

function AnalysesTable() {
  const t = useTranslations("admin.analyses.table");
  const pipelineStatusLabel = useEnumLabel("analysisStatus");
  const trackingStatusLabel = useEnumLabel("trackingStatus");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(() => parseAdminAnalysesTableState(searchParams), [searchParams]);
  const { data, isPending, isError } = useAdminAnalyses(state);
  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);

  const updateState = (patch: Partial<AdminAnalysesTableState>) => {
    const next: AdminAnalysesTableState = { ...state, ...patch, page: patch.page ?? 1 };
    const params = adminAnalysesTableStateToParams(next);
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <CandidatePicker
          id="admin-analyses-candidate"
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
          <Label htmlFor="admin-analyses-status">{t("statusLabel")}</Label>
          <select
            id="admin-analyses-status"
            className={SELECT_CLASS + " w-full"}
            value={state.status ?? "all"}
            onChange={(event) =>
              updateState({
                status:
                  event.target.value === "all"
                    ? null
                    : (event.target.value as AdminAnalysesTableState["status"]),
              })
            }
          >
            <option value="all">{t("statusAll")}</option>
            {ANALYSES_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === "FAILED" ? pipelineStatusLabel(status) : trackingStatusLabel(status)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-analyses-from">{t("requestedAtFromLabel")}</Label>
          <Input
            id="admin-analyses-from"
            type="date"
            value={state.requestedAtFrom}
            onChange={(event) => updateState({ requestedAtFrom: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-analyses-to">{t("requestedAtToLabel")}</Label>
          <Input
            id="admin-analyses-to"
            type="date"
            value={state.requestedAtTo}
            onChange={(event) => updateState({ requestedAtTo: event.target.value })}
          />
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
      {data && data.analyses.length === 0 && (
        <p className="text-sm text-muted">{total === 0 ? t("empty") : t("noMatches")}</p>
      )}

      {data && data.analyses.length > 0 && (
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
              {data.analyses.map((row) => (
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
                  {columnVisibility.isVisible("jobOffer") && (
                    <TableCell>
                      {row.jobOfferTitle ?? t("jobOfferFallback")}
                      <span className="block text-xs text-muted">{row.jobOfferCompany ?? "—"}</span>
                    </TableCell>
                  )}
                  {columnVisibility.isVisible("status") && (
                    <TableCell>
                      <TrackingBadge
                        row={row}
                        pipelineStatusLabel={pipelineStatusLabel}
                        trackingStatusLabel={trackingStatusLabel}
                      />
                    </TableCell>
                  )}
                  {columnVisibility.isVisible("requestedAt") && (
                    <TableCell>{new Date(row.requestedAt).toLocaleDateString()}</TableCell>
                  )}
                  <TableCell>
                    <AnalysisRowActions row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="admin-analyses-page-size" className="text-sm text-muted">
                {t("pagination.pageSizeLabel")}
              </Label>
              <select
                id="admin-analyses-page-size"
                className={SELECT_CLASS + " w-auto"}
                value={state.pageSize}
                onChange={(event) =>
                  updateState({ pageSize: Number(event.target.value) as AdminAnalysesPageSize })
                }
              >
                {ADMIN_ANALYSES_PAGE_SIZES.map((size) => (
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
    </div>
  );
}

/**
 * The Admin analyses table (issue #161): every candidate's Analyses in one
 * server-filtered, paginated table, Tracking status shown read-only, with
 * Re-run and Generate documents as the only row actions.
 */
export default function AdminAnalysesPage() {
  const t = useTranslations("admin.analyses");

  return (
    <Suspense fallback={null}>
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("description")}</p>
        </div>

        <section className="flex flex-col gap-2">
          <AnalysesTable />
        </section>
      </main>
    </Suspense>
  );
}
