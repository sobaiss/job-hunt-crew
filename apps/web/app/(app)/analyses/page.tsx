"use client";

import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, RefreshCw } from "lucide-react";

import {
  TERMINAL_ANALYSIS_STATUSES,
  useAnalyses,
  useAnalysisQuota,
  useBulkCreateAnalyses,
  type AnalysisSummary,
} from "@/hooks/use-analyses";
import { useBulkSetApplicationStatus } from "@/hooks/use-applications";
import {
  useBulkCreateGeneratedDocuments,
  useGeneratedDocumentsQuota,
  useGeneratedDocumentsStatuses,
} from "@/hooks/use-generated-documents";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  ANALYSES_PAGE_SIZES,
  JOB_OFFER_SOURCE_SITES,
  analysesTableStateToParams,
  cvLabelsOf,
  filterAnalyses,
  pageCount,
  paginate,
  parseAnalysesTableState,
  sortAnalyses,
  type AnalysesPageSize,
  type AnalysesSortColumn,
  type AnalysesTableState,
} from "@/lib/analyses-filters";
import { analysesToCsv, downloadCsv } from "@/lib/analyses-csv";
import {
  TRACKING_STATUSES,
  TRACKING_STATUS_TRANSITIONS,
  trackingStatusBadgeVariant,
  trackingStatusOf,
} from "@/lib/tracking-status";
import { useEnumLabel } from "@/lib/enum-labels";
import { analysisBadgeVariant } from "@/components/analysis-row";
import { AnalysisQuickView } from "@/components/analysis-quick-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// A styled native <select>: mirrors the matching-flow forms' SELECT_CLASS so
// the app reads as one system, and stays trivial to drive with user-event.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

type ColumnDef = {
  key: AnalysesSortColumn;
  labelKey: string;
  className?: string;
};

// Responsive column collapse (#69): as width shrinks, columns drop in this
// exact order (CV first, Entreprise/Localisation last) so Poste/Score/Statut/
// Lien and the selection checkbox — not listed here — always stay visible.
// Each entry is "hidden below breakpoint X", so a column requiring a bigger
// breakpoint drops out earlier while shrinking than one requiring a smaller
// one. Location (#116) shares Company's breakpoint — both are offer metadata
// of equal priority, so they collapse together.
const COLUMN_VISIBILITY: Partial<Record<AnalysesSortColumn, string>> = {
  cvLabel: "hidden xl:table-cell",
  sourceSite: "hidden lg:table-cell",
  postedAt: "hidden md:table-cell",
  company: "hidden sm:table-cell",
  location: "hidden sm:table-cell",
};

// The flat table's sortable columns, left to right (#63). "Lien" is sortable
// by `sourceUrl` too, but rendered separately since its cell is an icon, not
// text.
const COLUMNS: ColumnDef[] = [
  { key: "title", labelKey: "columns.title" },
  { key: "company", labelKey: "columns.company", className: COLUMN_VISIBILITY.company },
  { key: "location", labelKey: "columns.location", className: COLUMN_VISIBILITY.location },
  { key: "sourceSite", labelKey: "columns.platform", className: COLUMN_VISIBILITY.sourceSite },
  { key: "postedAt", labelKey: "columns.postedAt", className: COLUMN_VISIBILITY.postedAt },
  { key: "cvLabel", labelKey: "columns.cv", className: COLUMN_VISIBILITY.cvLabel },
  {
    key: "matchScore",
    labelKey: "columns.score",
    className: "text-right",
  },
];

function AnalysesTable() {
  const t = useTranslations("analyses");
  const td = useTranslations("analyses.detail");
  const sourceSiteLabel = useEnumLabel("sourceSite");
  const pipelineStatusLabel = useEnumLabel("analysisStatus");
  const trackingStatusLabel = useEnumLabel("trackingStatus");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data: analyses, isPending, isError, isFetching, refetch } = useAnalyses();
  const queryClient = useQueryClient();
  const bulkSetApplicationStatus = useBulkSetApplicationStatus();
  const bulkCreateGeneratedDocuments = useBulkCreateGeneratedDocuments();
  const { data: generatedDocumentsQuota } = useGeneratedDocumentsQuota();
  const bulkCreateAnalyses = useBulkCreateAnalyses();
  const { data: analysisQuota } = useAnalysisQuota();

  // Multi-select (#67): ids selected across however many pages the user has
  // extended the selection to via the "select all matching filters" banner —
  // not just the current page, so a bulk action can span pages.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Bulk "Générer les documents" (#68): a confirm step showing the remaining
  // daily quota, then the ids of the freshly created GeneratedDocument rows
  // this run produced, polled for a live ready/failed/total summary.
  const [bulkGenerateConfirming, setBulkGenerateConfirming] = useState(false);
  const [bulkGenerationDocumentIds, setBulkGenerationDocumentIds] = useState<string[]>([]);
  const bulkGenerationStatuses = useGeneratedDocumentsStatuses(bulkGenerationDocumentIds);

  // Bulk "Relancer l'analyse" (#126): unlike the two bulk actions above, only
  // a COMPLETED or FAILED Analysis is relaunchable (see the Quick view's own
  // `isRelaunchable`), and `POST /analyses` has no server-side check that
  // would reject a non-terminal one — it would just kick off a redundant,
  // quota-consuming re-run instead of failing. So the eligible subset is
  // filtered client-side rather than firing for the whole selection like
  // `handleBulkStatusChange`/`handleConfirmBulkGenerate` do.
  const [bulkRelaunchConfirming, setBulkRelaunchConfirming] = useState(false);

  // Which Analysis's Quick view (#65) is open, if any — looked up by id
  // rather than held as the row's data so it always reflects the latest
  // fetch instead of a stale snapshot taken at click time.
  const [quickViewId, setQuickViewId] = useState<string | null>(null);
  const quickViewTriggerRef = useRef<HTMLElement | null>(null);
  const quickViewAnalysis = useMemo(
    () => analyses?.find((a) => a.id === quickViewId) ?? null,
    [analyses, quickViewId],
  );

  const state = useMemo(
    () => parseAnalysesTableState(searchParams),
    [searchParams],
  );

  const cvLabels = useMemo(
    () => (analyses ? cvLabelsOf(analyses) : []),
    [analyses],
  );

  const filtered = useMemo(
    () => (analyses ? filterAnalyses(analyses, state) : []),
    [analyses, state],
  );
  const sorted = useMemo(
    () => sortAnalyses(filtered, state.sort),
    [filtered, state.sort],
  );
  const totalPages = pageCount(sorted.length, state.pageSize);
  const page = Math.min(state.page, totalPages);
  const rows = useMemo(
    () => paginate(sorted, page, state.pageSize),
    [sorted, page, state.pageSize],
  );

  // Any change to a filter, sort or page size resets `page` to 1 — a stale
  // page number from before the change would otherwise show an empty or
  // truncated table. Passing `page` explicitly (the pager buttons) opts out.
  const updateState = useCallback(
    (patch: Partial<AnalysesTableState>) => {
      const next: AnalysesTableState = {
        ...state,
        ...patch,
        page: patch.page ?? 1,
      };
      const qs = analysesTableStateToParams(next).toString();
      router.replace(`${pathname}?${qs}`, { scroll: false });
      // A selection tied to a search term, Tracking status filter or sort
      // that's about to change is confusing to keep around (#67) — page size
      // and the CV filter aren't in that list, so they leave it untouched.
      if (patch.search !== undefined || patch.status !== undefined || patch.sort !== undefined) {
        setSelectedIds(new Set());
        setBulkError(null);
        setBulkGenerateConfirming(false);
        setBulkGenerationDocumentIds([]);
        setBulkRelaunchConfirming(false);
      }
    },
    [state, router, pathname],
  );

  const pageIds = useMemo(() => rows.map((a) => a.id), [rows]);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));
  const selectedAnalyses = useMemo(
    () => (analyses ?? []).filter((a) => selectedIds.has(a.id)),
    [analyses, selectedIds],
  );

  const togglePageSelection = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  const toggleRowSelection = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedIds(new Set(filtered.map((a) => a.id)));
  };

  const handleBulkStatusChange = (applicationStatus: (typeof TRACKING_STATUS_TRANSITIONS)[number]["applicationStatus"]) => {
    setBulkError(null);
    const analysisIds = [...selectedIds];
    bulkSetApplicationStatus.mutate(
      { analysisIds, status: applicationStatus },
      {
        onSuccess: ({ failedAnalysisIds }) => {
          queryClient.invalidateQueries({ queryKey: ["analyses"] });
          if (failedAnalysisIds.length > 0) {
            setBulkError(
              t("bulk.statusPartialError", {
                failed: failedAnalysisIds.length,
                total: analysisIds.length,
              }),
            );
          }
        },
      },
    );
  };

  const requiredGenerationDocs = selectedIds.size * 2;
  const remainingGenerationQuota = generatedDocumentsQuota?.remaining;
  const insufficientGenerationQuota =
    remainingGenerationQuota !== undefined && requiredGenerationDocs > remainingGenerationQuota;

  const bulkGenerationSummary = useMemo(() => {
    if (bulkGenerationDocumentIds.length === 0) return null;
    let ready = 0;
    let failed = 0;
    for (const query of bulkGenerationStatuses) {
      if (query.data?.status === "READY") ready += 1;
      else if (query.data?.status === "FAILED") failed += 1;
    }
    return { ready, failed, total: bulkGenerationDocumentIds.length };
  }, [bulkGenerationDocumentIds, bulkGenerationStatuses]);

  const handleConfirmBulkGenerate = () => {
    setBulkError(null);
    const analysisIds = [...selectedIds];
    bulkCreateGeneratedDocuments.mutate(analysisIds, {
      onSuccess: ({ failedAnalysisIds, documentIds }) => {
        setBulkGenerateConfirming(false);
        setBulkGenerationDocumentIds(documentIds);
        if (failedAnalysisIds.length > 0) {
          setBulkError(
            t("bulk.generatePartialError", {
              failed: failedAnalysisIds.length,
              total: analysisIds.length,
            }),
          );
        }
      },
    });
  };

  const eligibleForRelaunch = useMemo(
    () => selectedAnalyses.filter((a) => TERMINAL_ANALYSIS_STATUSES.has(a.status)),
    [selectedAnalyses],
  );
  const eligibleRelaunchCount = eligibleForRelaunch.length;
  const skippedRelaunchCount = selectedIds.size - eligibleRelaunchCount;
  const remainingAnalysisQuota = analysisQuota?.remaining;
  const insufficientRelaunchQuota =
    remainingAnalysisQuota !== undefined && eligibleRelaunchCount > remainingAnalysisQuota;

  const handleConfirmBulkRelaunch = () => {
    setBulkError(null);
    const pairs = eligibleForRelaunch.map((a) => ({
      analysisId: a.id,
      jobOfferId: a.jobOffer.id,
      cvVersionId: a.cvVersionId,
    }));
    bulkCreateAnalyses.mutate(pairs, {
      onSuccess: ({ failedAnalysisIds }) => {
        setBulkRelaunchConfirming(false);
        queryClient.invalidateQueries({ queryKey: ["analyses"] });
        if (failedAnalysisIds.length > 0) {
          setBulkError(
            t("bulk.relaunchPartialError", {
              failed: failedAnalysisIds.length,
              total: pairs.length,
            }),
          );
        }
      },
    });
  };

  const handleExportCsv = () => {
    const csv = analysesToCsv(selectedAnalyses, {
      sourceSiteLabel,
      pipelineStatusLabel,
      trackingStatusLabel,
    });
    downloadCsv(t("bulk.csvFilename"), csv);
  };

  const toggleSort = (column: AnalysesSortColumn) => {
    updateState({
      sort:
        state.sort.column === column
          ? { column, direction: state.sort.direction === "asc" ? "desc" : "asc" }
          : { column, direction: "asc" },
    });
  };

  const hasAnalyses = Boolean(analyses && analyses.length > 0);

  // Below ~640px the table becomes cramped even with every collapsible
  // column dropped (#69), so it's replaced outright by a stacked card per
  // Analysis carrying the same fields and click/select/link behaviors.
  const isCardLayout = useMediaQuery("(max-width: 639px)");

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => refetch()}
        >
          <RefreshCw className={isFetching ? "size-4 animate-spin" : "size-4"} />
          {t("refresh")}
        </Button>
      </div>

      {isPending && (
        <div
          role="status"
          aria-label={t("loading")}
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      )}

      {analyses && analyses.length === 0 && (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}

      {hasAnalyses && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-search">{t("controls.searchLabel")}</Label>
            <Input
              id="analyses-search"
              type="search"
              placeholder={t("controls.searchPlaceholder")}
              value={state.search}
              onChange={(event) =>
                updateState({ search: event.target.value })
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-status">{t("controls.statusLabel")}</Label>
            <select
              id="analyses-status"
              className={SELECT_CLASS}
              value={state.status}
              onChange={(event) =>
                updateState({
                  status: event.target.value as AnalysesTableState["status"],
                })
              }
            >
              <option value="all">{t("controls.statusAll")}</option>
              {TRACKING_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {trackingStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-cv">{t("controls.cvLabel")}</Label>
            <select
              id="analyses-cv"
              className={SELECT_CLASS}
              value={state.cvLabel}
              onChange={(event) => updateState({ cvLabel: event.target.value })}
            >
              <option value="all">{t("controls.cvAll")}</option>
              {cvLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-platform">{t("controls.platformLabel")}</Label>
            <select
              id="analyses-platform"
              className={SELECT_CLASS}
              value={state.platform}
              onChange={(event) =>
                updateState({
                  platform: event.target.value as AnalysesTableState["platform"],
                })
              }
            >
              <option value="all">{t("controls.platformAll")}</option>
              {JOB_OFFER_SOURCE_SITES.map((site) => (
                <option key={site} value={site}>
                  {sourceSiteLabel(site)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-location">{t("controls.locationLabel")}</Label>
            <Input
              id="analyses-location"
              type="search"
              placeholder={t("controls.locationPlaceholder")}
              value={state.location}
              onChange={(event) =>
                updateState({ location: event.target.value })
              }
            />
          </div>
        </div>
      )}

      {hasAnalyses && sorted.length === 0 && (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      )}

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
          <span className="text-sm font-medium">
            {t("bulk.selectedCount", { count: selectedIds.size })}
          </span>
          {!allFilteredSelected && (
            <Button type="button" variant="link" size="sm" onClick={selectAllFiltered}>
              {t("bulk.extendAction", { total: filtered.length })}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedIds(new Set());
              setBulkError(null);
              setBulkGenerateConfirming(false);
              setBulkGenerationDocumentIds([]);
              setBulkRelaunchConfirming(false);
            }}
          >
            {t("bulk.clearSelection")}
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">
            {TRACKING_STATUS_TRANSITIONS.map((transition) => (
              <Button
                key={transition.trackingStatus}
                type="button"
                variant="outline"
                size="sm"
                disabled={bulkSetApplicationStatus.isPending}
                onClick={() => handleBulkStatusChange(transition.applicationStatus)}
              >
                {trackingStatusLabel(transition.trackingStatus)}
              </Button>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={handleExportCsv}>
              {t("bulk.exportCsv")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkCreateGeneratedDocuments.isPending}
              onClick={() => {
                setBulkRelaunchConfirming(false);
                setBulkGenerateConfirming(true);
              }}
            >
              {t("bulk.generateDocuments")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={eligibleRelaunchCount === 0 || bulkCreateAnalyses.isPending}
              onClick={() => {
                setBulkGenerateConfirming(false);
                setBulkRelaunchConfirming(true);
              }}
            >
              {td("retry")}
            </Button>
          </div>
          {bulkError && (
            <p role="alert" className="w-full text-sm text-destructive">
              {bulkError}
            </p>
          )}
          {bulkGenerateConfirming && (
            <div className="flex w-full flex-col gap-2 rounded-md border border-border bg-background p-3">
              <p className="text-sm">
                {t("bulk.generateConfirm", {
                  count: selectedIds.size,
                  remaining: remainingGenerationQuota ?? 0,
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={insufficientGenerationQuota || bulkCreateGeneratedDocuments.isPending}
                  onClick={handleConfirmBulkGenerate}
                >
                  {t("bulk.generateConfirmAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBulkGenerateConfirming(false)}
                >
                  {t("bulk.cancel")}
                </Button>
              </div>
              {insufficientGenerationQuota && (
                <p role="alert" className="text-sm text-destructive">
                  {t("bulk.generateInsufficientQuota")}
                </p>
              )}
            </div>
          )}
          {bulkGenerationSummary && (
            <p className="w-full text-sm text-muted">
              {t("bulk.generateProgress", bulkGenerationSummary)}
            </p>
          )}
          {bulkRelaunchConfirming && (
            <div className="flex w-full flex-col gap-2 rounded-md border border-border bg-background p-3">
              <p className="text-sm">
                {skippedRelaunchCount > 0
                  ? t("bulk.relaunchConfirmMixed", {
                      count: eligibleRelaunchCount,
                      skipped: skippedRelaunchCount,
                      remaining: remainingAnalysisQuota ?? 0,
                    })
                  : t("bulk.relaunchConfirm", {
                      count: eligibleRelaunchCount,
                      remaining: remainingAnalysisQuota ?? 0,
                    })}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={insufficientRelaunchQuota || bulkCreateAnalyses.isPending}
                  onClick={handleConfirmBulkRelaunch}
                >
                  {t("bulk.generateConfirmAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBulkRelaunchConfirming(false)}
                >
                  {t("bulk.cancel")}
                </Button>
              </div>
              {insufficientRelaunchQuota && (
                <p role="alert" className="text-sm text-destructive">
                  {t("bulk.relaunchInsufficientQuota")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {sorted.length > 0 && (
        <>
          {isCardLayout ? (
            <div className="flex flex-col gap-3">
              {rows.map((analysis) => (
                <AnalysisCard
                  key={analysis.id}
                  analysis={analysis}
                  sourceSiteLabel={sourceSiteLabel}
                  pipelineStatusLabel={pipelineStatusLabel}
                  trackingStatusLabel={trackingStatusLabel}
                  linkLabel={t("columns.linkLabel")}
                  jobOfferFallback={t("jobOfferFallback")}
                  selected={selectedIds.has(analysis.id)}
                  selectLabel={t("bulk.selectRowLabel", {
                    title: analysis.jobOffer.title ?? t("jobOfferFallback"),
                  })}
                  onToggleSelect={() => toggleRowSelection(analysis.id)}
                  onOpenQuickView={(row) => {
                    quickViewTriggerRef.current = row;
                    setQuickViewId(analysis.id);
                  }}
                />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-0">
                    <input
                      type="checkbox"
                      aria-label={t("bulk.selectPageLabel")}
                      checked={allPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = somePageSelected && !allPageSelected;
                      }}
                      onChange={togglePageSelection}
                    />
                  </TableHead>
                  {COLUMNS.map((column) => (
                    <SortableHead
                      key={column.key}
                      column={column.key}
                      label={t(column.labelKey)}
                      className={column.className}
                      sort={state.sort}
                      onSort={toggleSort}
                    />
                  ))}
                  <TableHead>{t("columns.status")}</TableHead>
                  <SortableHead
                    column="sourceUrl"
                    label={t("columns.link")}
                    className="w-0"
                    sort={state.sort}
                    onSort={toggleSort}
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((analysis) => (
                  <AnalysisTableRow
                    key={analysis.id}
                    analysis={analysis}
                    sourceSiteLabel={sourceSiteLabel}
                    pipelineStatusLabel={pipelineStatusLabel}
                    trackingStatusLabel={trackingStatusLabel}
                    linkLabel={t("columns.linkLabel")}
                    jobOfferFallback={t("jobOfferFallback")}
                    selected={selectedIds.has(analysis.id)}
                    selectLabel={t("bulk.selectRowLabel", {
                      title: analysis.jobOffer.title ?? t("jobOfferFallback"),
                    })}
                    onToggleSelect={() => toggleRowSelection(analysis.id)}
                    onOpenQuickView={(row) => {
                      quickViewTriggerRef.current = row;
                      setQuickViewId(analysis.id);
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="analyses-page-size" className="text-sm text-muted">
                {t("pagination.pageSizeLabel")}
              </Label>
              <select
                id="analyses-page-size"
                className={SELECT_CLASS + " w-auto"}
                value={state.pageSize}
                onChange={(event) =>
                  updateState({
                    pageSize: Number(event.target.value) as AnalysesPageSize,
                  })
                }
              >
                {ANALYSES_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">
                {t("pagination.pageInfo", { page, totalPages })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => updateState({ page: page - 1 })}
              >
                {t("pagination.previous")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => updateState({ page: page + 1 })}
              >
                {t("pagination.next")}
              </Button>
            </div>
          </div>
        </>
      )}

      <AnalysisQuickView
        analysis={quickViewAnalysis}
        // `quickViewId !== null` (not `quickViewAnalysis !== null`): right
        // after a successful relaunch (#124) the Quick view switches to the
        // new id before the invalidated list query has refetched it, so
        // `quickViewAnalysis` is briefly null — checking `quickViewId` keeps
        // the Sheet open through that gap instead of having Radix treat it
        // as a close, mirroring the CV-versions panel's Replace flow.
        open={quickViewId !== null}
        onOpenChange={(open) => {
          if (!open) setQuickViewId(null);
        }}
        pipelineStatusLabel={pipelineStatusLabel}
        trackingStatusLabel={trackingStatusLabel}
        returnFocusRef={quickViewTriggerRef}
        onRelaunched={(newId) => setQuickViewId(newId)}
      />
    </main>
  );
}

function SortableHead({
  column,
  label,
  className,
  sort,
  onSort,
}: {
  column: AnalysesSortColumn;
  label: string;
  className?: string;
  sort: AnalysesTableState["sort"];
  onSort: (column: AnalysesSortColumn) => void;
}) {
  const active = sort.column === column;
  const ariaSort = !active ? "none" : sort.direction === "asc" ? "ascending" : "descending";
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead aria-sort={ariaSort} className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(column)}
      >
        {label}
        <Icon className="size-3.5" />
      </button>
    </TableHead>
  );
}

function AnalysisTableRow({
  analysis,
  sourceSiteLabel,
  pipelineStatusLabel,
  trackingStatusLabel,
  linkLabel,
  jobOfferFallback,
  selected,
  selectLabel,
  onToggleSelect,
  onOpenQuickView,
}: {
  analysis: AnalysisSummary;
  sourceSiteLabel: (value: string) => string;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  linkLabel: string;
  jobOfferFallback: string;
  selected: boolean;
  selectLabel: string;
  onToggleSelect: () => void;
  onOpenQuickView: (row: HTMLTableRowElement) => void;
}) {
  return (
    <TableRow
      tabIndex={0}
      onClick={(event) => onOpenQuickView(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenQuickView(event.currentTarget);
        }
      }}
      className="cursor-pointer"
    >
      <TableCell onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={selectLabel}
          checked={selected}
          onChange={onToggleSelect}
        />
      </TableCell>
      <TableCell className="font-medium">
        {analysis.jobOffer.title ?? jobOfferFallback}
      </TableCell>
      <TableCell className={COLUMN_VISIBILITY.company}>
        {analysis.jobOffer.company ?? "—"}
      </TableCell>
      <TableCell className={COLUMN_VISIBILITY.location}>
        {analysis.jobOffer.location ?? "—"}
      </TableCell>
      <TableCell className={COLUMN_VISIBILITY.sourceSite}>
        {sourceSiteLabel(analysis.jobOffer.sourceSite)}
      </TableCell>
      <TableCell className={COLUMN_VISIBILITY.postedAt}>
        {analysis.jobOffer.postedAt
          ? new Date(analysis.jobOffer.postedAt).toLocaleDateString()
          : "—"}
      </TableCell>
      <TableCell className={COLUMN_VISIBILITY.cvLabel}>
        {analysis.cvVersion.label}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {analysis.matchScore ?? "—"}
      </TableCell>
      <TableCell>
        <TrackingBadge
          analysis={analysis}
          pipelineStatusLabel={pipelineStatusLabel}
          trackingStatusLabel={trackingStatusLabel}
        />
      </TableCell>
      <TableCell>
        <OfferLink
          href={analysis.jobOffer.sourceUrl}
          linkLabel={linkLabel}
          className="inline-flex text-muted hover:text-accent"
        />
      </TableCell>
    </TableRow>
  );
}

// Same fields and click/select/link behaviors as `AnalysisTableRow`, stacked
// into a card for the sub-~640px layout (#69) where the table is too cramped
// even with every collapsible column dropped.
function AnalysisCard({
  analysis,
  sourceSiteLabel,
  pipelineStatusLabel,
  trackingStatusLabel,
  linkLabel,
  jobOfferFallback,
  selected,
  selectLabel,
  onToggleSelect,
  onOpenQuickView,
}: {
  analysis: AnalysisSummary;
  sourceSiteLabel: (value: string) => string;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  linkLabel: string;
  jobOfferFallback: string;
  selected: boolean;
  selectLabel: string;
  onToggleSelect: () => void;
  onOpenQuickView: (row: HTMLDivElement) => void;
}) {
  return (
    <div
      tabIndex={0}
      onClick={(event) => onOpenQuickView(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenQuickView(event.currentTarget);
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-md border border-border bg-background p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            aria-label={selectLabel}
            checked={selected}
            onChange={onToggleSelect}
            onClick={(event) => event.stopPropagation()}
            className="mt-1"
          />
          <div>
            <p className="font-medium">
              {analysis.jobOffer.title ?? jobOfferFallback}
            </p>
            <p className="text-sm text-muted">
              {analysis.jobOffer.company ?? "—"} ·{" "}
              {analysis.jobOffer.location ?? "—"} ·{" "}
              {sourceSiteLabel(analysis.jobOffer.sourceSite)}
            </p>
          </div>
        </div>
        <OfferLink
          href={analysis.jobOffer.sourceUrl}
          linkLabel={linkLabel}
          className="inline-flex shrink-0 text-muted hover:text-accent"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <TrackingBadge
          analysis={analysis}
          pipelineStatusLabel={pipelineStatusLabel}
          trackingStatusLabel={trackingStatusLabel}
        />
        <span className="text-muted">{analysis.cvVersion.label}</span>
        <span className="ml-auto tabular-nums">
          {analysis.matchScore ?? "—"}
        </span>
      </div>
    </div>
  );
}

function TrackingBadge({
  analysis,
  pipelineStatusLabel,
  trackingStatusLabel,
}: {
  analysis: AnalysisSummary;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
}) {
  const tracking = trackingStatusOf(analysis);
  return tracking !== null ? (
    <Badge variant={trackingStatusBadgeVariant(tracking)}>
      {trackingStatusLabel(tracking)}
    </Badge>
  ) : (
    <Badge variant={analysisBadgeVariant(analysis.status)}>
      {pipelineStatusLabel(analysis.status)}
    </Badge>
  );
}

function OfferLink({
  href,
  linkLabel,
  className,
}: {
  href: string;
  linkLabel: string;
  className: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={linkLabel}
      onClick={(event) => event.stopPropagation()}
      className={className}
    >
      <ExternalLink className="size-4" />
    </a>
  );
}

export default function AnalysesDashboardPage() {
  return (
    <Suspense fallback={null}>
      <AnalysesTable />
    </Suspense>
  );
}
