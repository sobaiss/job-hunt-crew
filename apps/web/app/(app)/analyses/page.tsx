"use client";

import { Suspense, useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink } from "lucide-react";

import { useAnalyses, type AnalysisSummary } from "@/hooks/use-analyses";
import {
  ANALYSES_PAGE_SIZES,
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
import {
  TRACKING_STATUSES,
  trackingStatusBadgeVariant,
  trackingStatusOf,
} from "@/lib/tracking-status";
import { useEnumLabel } from "@/lib/enum-labels";
import { analysisBadgeVariant } from "@/components/analysis-row";
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

// The flat table's sortable columns, left to right (#63). "Lien" is sortable
// by `sourceUrl` too, but rendered separately since its cell is an icon, not
// text.
const COLUMNS: ColumnDef[] = [
  { key: "title", labelKey: "columns.title" },
  { key: "company", labelKey: "columns.company" },
  { key: "sourceSite", labelKey: "columns.platform" },
  { key: "postedAt", labelKey: "columns.postedAt" },
  { key: "cvLabel", labelKey: "columns.cv" },
  { key: "matchScore", labelKey: "columns.score", className: "text-right" },
];

function AnalysesTable() {
  const t = useTranslations("analyses");
  const sourceSiteLabel = useEnumLabel("sourceSite");
  const pipelineStatusLabel = useEnumLabel("analysisStatus");
  const trackingStatusLabel = useEnumLabel("trackingStatus");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { data: analyses, isPending, isError } = useAnalyses();

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
    },
    [state, router, pathname],
  );

  const toggleSort = (column: AnalysesSortColumn) => {
    updateState({
      sort:
        state.sort.column === column
          ? { column, direction: state.sort.direction === "asc" ? "desc" : "asc" }
          : { column, direction: "asc" },
    });
  };

  const hasAnalyses = Boolean(analyses && analyses.length > 0);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>

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
        </div>
      )}

      {hasAnalyses && sorted.length === 0 && (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      )}

      {sorted.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
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
                />
              ))}
            </TableBody>
          </Table>

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
}: {
  analysis: AnalysisSummary;
  sourceSiteLabel: (value: string) => string;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  linkLabel: string;
  jobOfferFallback: string;
}) {
  const tracking = trackingStatusOf(analysis);

  return (
    <TableRow>
      <TableCell>
        <Link href={`/analyses/${analysis.id}`} className="font-medium hover:underline">
          {analysis.jobOffer.title ?? jobOfferFallback}
        </Link>
      </TableCell>
      <TableCell>{analysis.jobOffer.company ?? "—"}</TableCell>
      <TableCell>{sourceSiteLabel(analysis.jobOffer.sourceSite)}</TableCell>
      <TableCell>
        {analysis.jobOffer.postedAt
          ? new Date(analysis.jobOffer.postedAt).toLocaleDateString()
          : "—"}
      </TableCell>
      <TableCell>{analysis.cvVersion.label}</TableCell>
      <TableCell className="text-right tabular-nums">
        {analysis.matchScore ?? "—"}
      </TableCell>
      <TableCell>
        {tracking !== null ? (
          <Badge variant={trackingStatusBadgeVariant(tracking)}>
            {trackingStatusLabel(tracking)}
          </Badge>
        ) : (
          <Badge variant={analysisBadgeVariant(analysis.status)}>
            {pipelineStatusLabel(analysis.status)}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <a
          href={analysis.jobOffer.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={linkLabel}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex text-muted hover:text-accent"
        >
          <ExternalLink className="size-4" />
        </a>
      </TableCell>
    </TableRow>
  );
}

export default function AnalysesDashboardPage() {
  return (
    <Suspense fallback={null}>
      <AnalysesTable />
    </Suspense>
  );
}
