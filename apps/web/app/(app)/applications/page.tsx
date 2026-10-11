"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileDown,
  ListChecks,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";

import {
  useApplications,
  useApplicationStats,
  useBulkSetApplicationStatus,
} from "@/hooks/use-applications";
import { useScouts } from "@/hooks/use-scouts";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { SortableHead } from "@/components/sortable-head";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { CheckboxFilterMenu } from "@/components/checkbox-filter-menu";
import { ApplicationStatsHeader } from "@/components/application-stats-header";
import { GeneratedDocumentStatusBadge } from "@/components/generated-document-status-badge";
import { TruncatedCell } from "@/components/truncated-cell";
import type { ColumnConfig } from "@/lib/column-visibility";
import { downloadCsv } from "@/lib/analyses-csv";
import { applicationsToCsv } from "@/lib/applications-csv";
import { JOB_OFFER_SOURCE_SITES } from "@/lib/analyses-filters";
import {
  APPLICATIONS_PAGE_SIZES,
  DEFAULT_APPLICATIONS_FILTERS,
  activeAdvancedFilterCount,
  applicationsTableStateToParams,
  filterApplications,
  hasActiveFilters,
  pageCount,
  paginate,
  parseApplicationsTableState,
  sortApplications,
  type ApplicationSummary,
  type ApplicationsPageSize,
  type ApplicationsTableState,
} from "@/lib/applications-filters";
import {
  TRACKING_STATUSES,
  TRACKING_STATUS_TRANSITIONS,
  trackingStatusBadgeVariant,
  trackingStatusIcon,
  trackingStatusOfApplication,
} from "@/lib/tracking-status";
import { useEnumLabel } from "@/lib/enum-labels";
import { SHORT_FIELD_MAX_LENGTH, TITLE_MAX_LENGTH } from "@/lib/text-truncation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

// A styled native <select>: mirrors the analyses list controls' SELECT_CLASS
// so the app reads as one system.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:applications";

type ApplicationsColumn =
  | "title"
  | "company"
  | "location"
  | "sourceSite"
  | "appliedAt"
  | "matchScore"
  | "tailoredCvStatus"
  | "coverLetterStatus";

// Left to right (#236). Poste is the only non-hideable one — it, the Statut
// badge and "Lien" always stay visible and are never in the Columns menu. The
// score is hidden by default so it doesn't dominate a view about tracking
// rather than evaluation; location, platform and the two document statuses
// start hidden too, since `GET /applications` does not send them yet and a
// column of dashes is noise until it does.
const COLUMNS: ColumnConfig<ApplicationsColumn>[] = [
  { key: "title", labelKey: "columns.title", hideable: false },
  { key: "company", labelKey: "columns.company", hideable: true },
  { key: "location", labelKey: "columns.location", hideable: true, defaultVisible: false },
  { key: "sourceSite", labelKey: "columns.platform", hideable: true, defaultVisible: false },
  { key: "appliedAt", labelKey: "columns.appliedAt", hideable: true },
  {
    key: "matchScore",
    labelKey: "columns.score",
    hideable: true,
    defaultVisible: false,
    className: "text-right",
  },
  {
    key: "tailoredCvStatus",
    labelKey: "columns.tailoredCvStatus",
    hideable: true,
    defaultVisible: false,
  },
  {
    key: "coverLetterStatus",
    labelKey: "columns.coverLetterStatus",
    hideable: true,
    defaultVisible: false,
  },
];

/**
 * The Applications tracker, rebuilt on the Analyses table's conventions
 * (#236): a sortable table (cards below ~640px) with hideable columns, a
 * search box and Tracking status filter up front, the rest folded behind
 * "Plus de filtres", and the stats moved into a modal opened on demand. All
 * filtering, sorting and pagination run client-side over the full list, with
 * the state held in the URL by `applications-filters.ts`.
 */
function ApplicationsTable() {
  const t = useTranslations("applications");
  const sourceSiteLabel = useEnumLabel("sourceSite");
  const trackingStatusLabel = useEnumLabel("trackingStatus");
  const generatedDocumentStatusLabel = useEnumLabel("generatedDocumentStatus");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Unfiltered on purpose: the API's `status` filter speaks the raw 7-value
  // ApplicationStatus, not the 5 Tracking status buckets the table filters on,
  // so the whole list is fetched once and narrowed here.
  const { data: applications, isPending, isError, isFetching, refetch } = useApplications();
  const { data: scouts } = useScouts();
  const [statsOpen, setStatsOpen] = useState(false);
  const bulkSetApplicationStatus = useBulkSetApplicationStatus();

  // Multi-select (#238), as on /analyses: Application ids selected across
  // however many pages the user has visited, so a bulk action can span pages
  // and "select all matching" can reach rows the current page doesn't show.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);

  const state = useMemo(() => parseApplicationsTableState(searchParams), [searchParams]);

  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);

  // Starts open when the URL already carries a folded-away filter, so a
  // shared or refreshed link shows what is narrowing the table.
  const advancedFilterCount = activeAdvancedFilterCount(state);
  const [filtersOpen, setFiltersOpen] = useState(() => advancedFilterCount > 0);

  const filtered = useMemo(
    () => (applications ? filterApplications(applications, state) : []),
    [applications, state],
  );
  const sorted = useMemo(() => sortApplications(filtered, state), [filtered, state]);
  const totalPages = pageCount(sorted, state);
  const page = Math.min(state.page, totalPages);
  const rows = useMemo(
    () => paginate(sorted, { page, pageSize: state.pageSize }),
    [sorted, page, state.pageSize],
  );

  // Any change to a filter, sort or page size resets `page` to 1 — a stale
  // page number would otherwise show an empty or truncated table. Passing
  // `page` explicitly (the pager buttons) opts out.
  const updateState = useCallback(
    (patch: Partial<ApplicationsTableState>) => {
      const next: ApplicationsTableState = { ...state, ...patch, page: patch.page ?? 1 };
      const qs = applicationsTableStateToParams(next).toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [state, router, pathname],
  );

  const pageIds = useMemo(() => rows.map((a) => a.id), [rows]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));
  // In table order, so the CSV reads like the screen.
  const selectedApplications = useMemo(
    () => sorted.filter((a) => selectedIds.has(a.id)),
    [sorted, selectedIds],
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

  // The bulk hook speaks analysisIds (it get-or-creates the Application from
  // its Analysis, for /analyses' sake); for a row that already is an
  // Application that lookup just returns it, so the StatusEvent lands on the
  // selected row.
  const handleBulkStatusChange = (
    applicationStatus: (typeof TRACKING_STATUS_TRANSITIONS)[number]["applicationStatus"],
  ) => {
    setBulkError(null);
    const analysisIds = (applications ?? [])
      .filter((a) => selectedIds.has(a.id))
      .map((a) => a.analysisId);
    bulkSetApplicationStatus.mutate(
      { analysisIds, status: applicationStatus },
      {
        onSuccess: ({ failedAnalysisIds }) => {
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

  const handleExportCsv = () => {
    const csv = applicationsToCsv(selectedApplications, {
      sourceSiteLabel,
      trackingStatusLabel,
      documentStatusLabel: generatedDocumentStatusLabel,
    });
    downloadCsv(t("bulk.csvFilename"), csv);
  };

  const toggleSort = () => {
    updateState({ sortDir: state.sortDir === "asc" ? "desc" : "asc" });
  };

  const hasApplications = Boolean(applications && applications.length > 0);
  const isCardLayout = useMediaQuery("(max-width: 639px)");
  const jobOfferFallback = t("list.jobOfferFallback");
  const linkLabel = t("columns.linkLabel");

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setStatsOpen(true)}>
            <BarChart3 aria-hidden="true" />
            {t("controls.stats")}
          </Button>
          <ColumnVisibilityMenu
            columns={COLUMNS}
            isVisible={columnVisibility.isVisible}
            onToggle={columnVisibility.toggle}
            onReset={columnVisibility.reset}
            label={t("controls.columnsLabel")}
            columnLabel={(labelKey) => t(labelKey)}
            resetLabel={t("controls.columnsReset")}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw aria-hidden="true" className={isFetching ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
        </div>
      </div>

      {isPending && (
        <div role="status" aria-label={t("loading")} className="flex flex-col gap-3">
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

      {applications && applications.length === 0 && (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}

      {hasApplications && (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-panel/40 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex flex-col gap-1.5 lg:flex-1">
              <Label htmlFor="applications-search">{t("controls.searchLabel")}</Label>
              <Input
                id="applications-search"
                type="search"
                placeholder={t("controls.searchPlaceholder")}
                value={state.q}
                onChange={(event) => updateState({ q: event.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5 lg:w-56">
              <Label id="applications-status-label" htmlFor="applications-status">
                {t("controls.statusLabel")}
              </Label>
              <CheckboxFilterMenu
                id="applications-status"
                labelId="applications-status-label"
                emptyLabel={t("controls.statusAll")}
                values={TRACKING_STATUSES}
                selected={state.status}
                onChange={(status) => updateState({ status })}
                valueLabel={trackingStatusLabel}
                countLabel={(count) => t("controls.statusCount", { count })}
                clearLabel={t("controls.clearThisFilter")}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={filtersOpen}
                aria-controls="applications-advanced-filters"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal aria-hidden="true" />
                {advancedFilterCount > 0
                  ? t("controls.moreFiltersActive", { count: advancedFilterCount })
                  : t("controls.moreFilters")}
                <ChevronDown
                  aria-hidden="true"
                  className={filtersOpen ? "rotate-180 transition-transform" : "transition-transform"}
                />
              </Button>
              {hasActiveFilters(state) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => updateState(DEFAULT_APPLICATIONS_FILTERS)}
                >
                  <X aria-hidden="true" />
                  {t("controls.clearFilters")}
                </Button>
              )}
            </div>
          </div>

          {filtersOpen && (
            <div
              id="applications-advanced-filters"
              className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="applications-applied-from">{t("controls.appliedAtFromLabel")}</Label>
                <Input
                  id="applications-applied-from"
                  type="date"
                  value={state.appliedAtFrom}
                  onChange={(event) => updateState({ appliedAtFrom: event.target.value })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="applications-applied-to">{t("controls.appliedAtToLabel")}</Label>
                <Input
                  id="applications-applied-to"
                  type="date"
                  value={state.appliedAtTo}
                  onChange={(event) => updateState({ appliedAtTo: event.target.value })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="applications-scout">{t("controls.scoutLabel")}</Label>
                <select
                  id="applications-scout"
                  className={SELECT_CLASS}
                  value={state.scoutId}
                  onChange={(event) => updateState({ scoutId: event.target.value })}
                >
                  <option value="all">{t("controls.scoutAll")}</option>
                  {scouts?.map((scout) => (
                    <option key={scout.id} value={scout.id}>
                      {scout.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label id="applications-platform-label" htmlFor="applications-platform">
                  {t("controls.platformLabel")}
                </Label>
                <CheckboxFilterMenu
                  id="applications-platform"
                  labelId="applications-platform-label"
                  emptyLabel={t("controls.platformAll")}
                  values={JOB_OFFER_SOURCE_SITES}
                  selected={state.sourceSite}
                  onChange={(sourceSite) => updateState({ sourceSite })}
                  valueLabel={sourceSiteLabel}
                  countLabel={(count) => t("controls.platformCount", { count })}
                  clearLabel={t("controls.clearThisFilter")}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="applications-location">{t("controls.locationLabel")}</Label>
                <Input
                  id="applications-location"
                  type="search"
                  placeholder={t("controls.locationPlaceholder")}
                  value={state.location}
                  onChange={(event) => updateState({ location: event.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {hasApplications && sorted.length === 0 && (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      )}

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
          <span className="text-sm font-medium">
            {t("bulk.selectedCount", { count: selectedIds.size })}
          </span>
          {!allFilteredSelected && (
            <Button type="button" variant="link" size="sm" onClick={selectAllFiltered}>
              <ListChecks aria-hidden="true" />
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
            }}
          >
            <X aria-hidden="true" />
            {t("bulk.clearSelection")}
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">
            {TRACKING_STATUS_TRANSITIONS.map((transition) => {
              const Icon = trackingStatusIcon(transition.trackingStatus);
              return (
                <Button
                  key={transition.trackingStatus}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={bulkSetApplicationStatus.isPending}
                  onClick={() => handleBulkStatusChange(transition.applicationStatus)}
                >
                  <Icon aria-hidden="true" />
                  {trackingStatusLabel(transition.trackingStatus)}
                </Button>
              );
            })}
            <Button type="button" variant="outline" size="sm" onClick={handleExportCsv}>
              <FileDown aria-hidden="true" />
              {t("bulk.exportCsv")}
            </Button>
          </div>
          {bulkError && (
            <p role="alert" className="w-full text-sm text-destructive">
              {bulkError}
            </p>
          )}
        </div>
      )}

      {sorted.length > 0 && (
        <>
          {isCardLayout ? (
            <div className="flex flex-col gap-3">
              {rows.map((application) => (
                <ApplicationCard
                  key={application.id}
                  application={application}
                  sourceSiteLabel={sourceSiteLabel}
                  trackingStatusLabel={trackingStatusLabel}
                  linkLabel={linkLabel}
                  jobOfferFallback={jobOfferFallback}
                  selected={selectedIds.has(application.id)}
                  selectLabel={t("bulk.selectRowLabel", {
                    title: application.jobOffer.title ?? jobOfferFallback,
                  })}
                  onToggleSelect={() => toggleRowSelection(application.id)}
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
                  {COLUMNS.filter((column) => columnVisibility.isVisible(column.key)).map(
                    (column) =>
                      column.key === "appliedAt" ? (
                        <SortableHead
                          key={column.key}
                          column="appliedAt"
                          label={t(column.labelKey)}
                          sort={{ column: "appliedAt", direction: state.sortDir }}
                          onSort={toggleSort}
                        />
                      ) : (
                        <TableHead key={column.key} className={column.className}>
                          {t(column.labelKey)}
                        </TableHead>
                      ),
                  )}
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="w-0">{t("columns.link")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((application) => (
                  <ApplicationTableRow
                    key={application.id}
                    application={application}
                    isColumnVisible={columnVisibility.isVisible}
                    sourceSiteLabel={sourceSiteLabel}
                    trackingStatusLabel={trackingStatusLabel}
                    generatedDocumentStatusLabel={generatedDocumentStatusLabel}
                    linkLabel={linkLabel}
                    jobOfferFallback={jobOfferFallback}
                    selected={selectedIds.has(application.id)}
                    selectLabel={t("bulk.selectRowLabel", {
                      title: application.jobOffer.title ?? jobOfferFallback,
                    })}
                    onToggleSelect={() => toggleRowSelection(application.id)}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="applications-page-size" className="text-sm text-muted">
                {t("pagination.pageSizeLabel")}
              </Label>
              <select
                id="applications-page-size"
                className={SELECT_CLASS + " w-auto"}
                value={state.pageSize}
                onChange={(event) =>
                  updateState({ pageSize: Number(event.target.value) as ApplicationsPageSize })
                }
              >
                {APPLICATIONS_PAGE_SIZES.map((size) => (
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
                <ChevronLeft aria-hidden="true" />
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
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}

      <Dialog open={statsOpen} onOpenChange={setStatsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("statsTitle")}</DialogTitle>
          </DialogHeader>
          {statsOpen && <ApplicationStatsModalBody />}
        </DialogContent>
      </Dialog>
    </main>
  );
}

/** Mounted only while the modal is open, so the stats are fetched on demand
 *  rather than with every visit to the table. */
function ApplicationStatsModalBody() {
  const stats = useApplicationStats();
  return (
    <ApplicationStatsHeader stats={stats.data} isPending={stats.isPending} isError={stats.isError} />
  );
}

function ApplicationTableRow({
  application,
  isColumnVisible,
  sourceSiteLabel,
  trackingStatusLabel,
  generatedDocumentStatusLabel,
  linkLabel,
  jobOfferFallback,
  selected,
  selectLabel,
  onToggleSelect,
}: {
  application: ApplicationSummary;
  isColumnVisible: (column: ApplicationsColumn) => boolean;
  sourceSiteLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  generatedDocumentStatusLabel: (value: string) => string;
  linkLabel: string;
  jobOfferFallback: string;
  selected: boolean;
  selectLabel: string;
  onToggleSelect: () => void;
}) {
  const { jobOffer } = application;
  return (
    <TableRow data-application-id={application.id}>
      <TableCell>
        <input
          type="checkbox"
          aria-label={selectLabel}
          checked={selected}
          onChange={onToggleSelect}
        />
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/applications/${application.id}`} className="hover:text-accent">
          <TruncatedCell text={jobOffer.title ?? jobOfferFallback} maxLength={TITLE_MAX_LENGTH} />
        </Link>
      </TableCell>
      {isColumnVisible("company") && (
        <TableCell>
          {jobOffer.company ? (
            <TruncatedCell text={jobOffer.company} maxLength={SHORT_FIELD_MAX_LENGTH} />
          ) : (
            "—"
          )}
        </TableCell>
      )}
      {isColumnVisible("location") && (
        <TableCell>
          {jobOffer.location ? (
            <TruncatedCell text={jobOffer.location} maxLength={SHORT_FIELD_MAX_LENGTH} />
          ) : (
            "—"
          )}
        </TableCell>
      )}
      {isColumnVisible("sourceSite") && (
        <TableCell>{jobOffer.sourceSite ? sourceSiteLabel(jobOffer.sourceSite) : "—"}</TableCell>
      )}
      {isColumnVisible("appliedAt") && (
        <TableCell>
          {application.appliedAt ? new Date(application.appliedAt).toLocaleDateString() : "—"}
        </TableCell>
      )}
      {isColumnVisible("matchScore") && (
        <TableCell className="text-right tabular-nums">{application.matchScore ?? "—"}</TableCell>
      )}
      {isColumnVisible("tailoredCvStatus") && (
        <TableCell>
          <GeneratedDocumentStatusBadge
            status={application.tailoredCvStatus}
            label={generatedDocumentStatusLabel}
          />
        </TableCell>
      )}
      {isColumnVisible("coverLetterStatus") && (
        <TableCell>
          <GeneratedDocumentStatusBadge
            status={application.coverLetterStatus}
            label={generatedDocumentStatusLabel}
          />
        </TableCell>
      )}
      <TableCell>
        <TrackingBadge application={application} trackingStatusLabel={trackingStatusLabel} />
      </TableCell>
      <TableCell>
        <OfferLink
          href={jobOffer.sourceUrl}
          linkLabel={linkLabel}
          className="inline-flex text-muted hover:text-accent"
        />
      </TableCell>
    </TableRow>
  );
}

// The same fields as `ApplicationTableRow`, stacked into a card for the
// sub-~640px layout where the table is too cramped.
function ApplicationCard({
  application,
  sourceSiteLabel,
  trackingStatusLabel,
  linkLabel,
  jobOfferFallback,
  selected,
  selectLabel,
  onToggleSelect,
}: {
  application: ApplicationSummary;
  sourceSiteLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  linkLabel: string;
  jobOfferFallback: string;
  selected: boolean;
  selectLabel: string;
  onToggleSelect: () => void;
}) {
  const { jobOffer } = application;
  return (
    <div
      data-application-id={application.id}
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            aria-label={selectLabel}
            checked={selected}
            onChange={onToggleSelect}
            className="mt-1"
          />
          <div>
            <Link
              href={`/applications/${application.id}`}
              className="font-medium hover:text-accent"
            >
              {jobOffer.title ?? jobOfferFallback}
            </Link>
            <p className="text-sm text-muted">
              {jobOffer.company ?? "—"} · {jobOffer.location ?? "—"}
              {jobOffer.sourceSite ? ` · ${sourceSiteLabel(jobOffer.sourceSite)}` : ""}
            </p>
          </div>
        </div>
        <OfferLink
          href={jobOffer.sourceUrl}
          linkLabel={linkLabel}
          className="inline-flex shrink-0 text-muted hover:text-accent"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <TrackingBadge application={application} trackingStatusLabel={trackingStatusLabel} />
        {application.appliedAt && (
          <span className="text-muted">
            {new Date(application.appliedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

function TrackingBadge({
  application,
  trackingStatusLabel,
}: {
  application: ApplicationSummary;
  trackingStatusLabel: (value: string) => string;
}) {
  const tracking = trackingStatusOfApplication(application.status);
  return (
    <Badge variant={trackingStatusBadgeVariant(tracking)}>{trackingStatusLabel(tracking)}</Badge>
  );
}

/** The offer's external link, or a muted "—" while the list response does not
 *  carry the offer's `sourceUrl` (see `ApplicationSummary`). */
function OfferLink({
  href,
  linkLabel,
  className,
}: {
  href: string | null | undefined;
  linkLabel: string;
  className: string;
}) {
  if (!href) return <span className="text-muted">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={linkLabel}
      className={className}
    >
      <ExternalLink className="size-4" />
    </a>
  );
}

export default function ApplicationsPage() {
  return (
    <Suspense fallback={null}>
      <ApplicationsTable />
    </Suspense>
  );
}
