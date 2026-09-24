"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileDown,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";

import {
  TERMINAL_ANALYSIS_STATUSES,
  useAnalysesCvLabels,
  useAnalysesPage,
  useBulkCreateAnalyses,
  useBulkRequeueAnalyses,
  type AnalysisDetail,
  type AnalysisSummary,
} from "@/hooks/use-analyses";
import { useBulkSetApplicationStatus } from "@/hooks/use-applications";
import {
  useBulkCreateGeneratedDocuments,
  useGeneratedDocumentsStatuses,
  type GeneratedDocumentStatus,
  type GeneratedDocumentType,
} from "@/hooks/use-generated-documents";
import { useQuotas } from "@/hooks/use-quotas";
import { useDebouncedField } from "@/hooks/use-debounced-field";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { SortableHead } from "@/components/sortable-head";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { CheckboxFilterMenu } from "@/components/checkbox-filter-menu";
import type { ColumnConfig } from "@/lib/column-visibility";
import {
  ANALYSES_PAGE_SIZES,
  DEFAULT_ANALYSES_FILTERS,
  JOB_OFFER_SOURCE_SITES,
  activeAdvancedFilterCount,
  analysesTableStateToParams,
  hasActiveFilters,
  pageCount,
  parseAnalysesTableState,
  type AnalysesPageSize,
  type AnalysesSortColumn,
  type AnalysesTableState,
} from "@/lib/analyses-filters";
import { analysesToCsv, downloadCsv } from "@/lib/analyses-csv";
import {
  ANALYSES_STATUS_FILTERS,
  TRACKING_STATUS_TRANSITIONS,
  isPipelineStatusFilter,
  trackingStatusBadgeVariant,
  trackingStatusIcon,
  trackingStatusOf,
} from "@/lib/tracking-status";
import { useEnumLabel } from "@/lib/enum-labels";
import { SHORT_FIELD_MAX_LENGTH, TITLE_MAX_LENGTH } from "@/lib/text-truncation";
import { analysisBadgeVariant } from "@/components/analysis-row";
import { AnalysisQuickView } from "@/components/analysis-quick-view";
import { TruncatedCell } from "@/components/truncated-cell";
import { CopyIdButton } from "@/components/copy-id-button";
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

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:analyses";

// One bulk button per document, in the order the Quick view's own panel
// stacks its two slots, and carrying that panel's labels so the same act is
// named the same in both places. There is deliberately no "both at once"
// button: documents coming in pairs was never a domain rule, only the shape
// of the first screen that needed them (docs/adr/0031).
const GENERATION_BUTTONS: readonly {
  type: GeneratedDocumentType;
  labelKey: string;
}[] = [
  { type: "COVER_LETTER", labelKey: "generatedDocuments.generateCoverLetter" },
  { type: "TAILORED_CV", labelKey: "generatedDocuments.generateTailoredCv" },
];

/** Whether a bulk "Générer…" click would actually create this document for
 *  this Analysis. The API rejects anything not `COMPLETED` (its resultJSON is
 *  what steers the generation agents), and a row that already carries this
 *  type would spend a quota on a duplicate `list_generated_documents` hides
 *  anyway — docs/adr/0031's one open hole, which a button firing at 25 rows
 *  at a time would widen. A `FAILED` document stays eligible: asking again is
 *  how a candidate retries it from the list rather than one Quick view at a
 *  time. */
function needsGeneratedDocument(
  analysis: AnalysisSummary,
  type: GeneratedDocumentType,
): boolean {
  if (analysis.status !== "COMPLETED") return false;
  const status =
    type === "COVER_LETTER"
      ? analysis.coverLetterStatus
      : analysis.tailoredCvStatus;
  return status == null || status === "FAILED";
}

// The flat table's sortable columns, left to right (#63). "Lien" is sortable
// by `sourceUrl` too, but rendered separately since its cell is an icon, not
// text. Poste (`title`) is the only non-`hideable` one — it, the selection
// checkbox and "Lien" always stay visible and are never in the Columns menu
// (#129). This also replaces the old breakpoint-based auto-hide (docs/adr/
// 0012): visibility is now decided solely by the candidate's Columns choice,
// at every viewport.
const COLUMNS: ColumnConfig<AnalysesSortColumn>[] = [
  { key: "title", labelKey: "columns.title", hideable: false },
  { key: "id", labelKey: "columns.id", hideable: true },
  { key: "company", labelKey: "columns.company", hideable: true },
  { key: "location", labelKey: "columns.location", hideable: true },
  { key: "sourceSite", labelKey: "columns.platform", hideable: true },
  { key: "postedAt", labelKey: "columns.postedAt", hideable: true },
  { key: "requestedAt", labelKey: "columns.requestedAt", hideable: true },
  { key: "cvLabel", labelKey: "columns.cv", hideable: true },
  {
    key: "matchScore",
    labelKey: "columns.score",
    hideable: true,
    className: "text-right",
  },
  { key: "tailoredCvStatus", labelKey: "columns.tailoredCvStatus", hideable: true },
  { key: "coverLetterStatus", labelKey: "columns.coverLetterStatus", hideable: true },
];

function AnalysesTable() {
  const t = useTranslations("analyses");
  const td = useTranslations("analyses.detail");
  const sourceSiteLabel = useEnumLabel("sourceSite");
  const pipelineStatusLabel = useEnumLabel("analysisStatus");
  const trackingStatusLabel = useEnumLabel("trackingStatus");
  const generatedDocumentStatusLabel = useEnumLabel("generatedDocumentStatus");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const state = useMemo(
    () => parseAnalysesTableState(searchParams),
    [searchParams],
  );

  const {
    data: analysesPage,
    isPending,
    isError,
    isFetching,
    refetch,
  } = useAnalysesPage(state);
  const rows = useMemo(() => analysesPage?.analyses ?? [], [analysesPage]);
  const total = analysesPage?.total ?? 0;
  const totalPages = pageCount(total, state.pageSize);
  // The page the server actually served, which it clamps to the last one when
  // asked for a page a filter or a deletion has outlived. Reading it back from
  // the response rather than clamping here keeps one authority over what "page
  // 9 of 2" means, and costs no extra request.
  const page = analysesPage?.page ?? state.page;
  const { data: cvLabels } = useAnalysesCvLabels();
  const queryClient = useQueryClient();
  const bulkSetApplicationStatus = useBulkSetApplicationStatus();
  const bulkCreateGeneratedDocuments = useBulkCreateGeneratedDocuments();
  const bulkCreateAnalyses = useBulkCreateAnalyses();
  const bulkRequeueAnalyses = useBulkRequeueAnalyses();
  const { data: quotas } = useQuotas();

  // Multi-select (#67): ids selected across however many pages the user has
  // extended the selection to via the "select all matching filters" banner —
  // not just the current page, so a bulk action can span pages.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Why an action did nothing, when that is an ordinary state of affairs
  // rather than a failure — a selection holding no interrupted row, say.
  // Kept apart from `bulkError` so it doesn't read as something breaking.
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  // Bulk generation (#68, split per document type here as docs/adr/0031 split
  // the Quick view's panel): which document a confirm step is currently open
  // for, if any — showing the remaining daily quota and what the selection
  // would actually spend — then the ids of every GeneratedDocument row the
  // bar's runs have created, polled for a live ready/failed/total summary.
  // One list across both types, since a candidate asking for a letter and
  // then a CV is watching one batch, not two.
  const [bulkGenerateConfirming, setBulkGenerateConfirming] =
    useState<GeneratedDocumentType | null>(null);
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

  // Whether the Quick view (#65) is open, and which Analysis it is on — an id
  // rather than the row's data, so it always reflects the latest fetch instead
  // of a stale snapshot taken at click time. The two are separate because the
  // panel can be open on a rank whose id is not known yet: see the navigation
  // section below.
  const [quickViewOpen, setQuickViewOpen] = useState(false);
  const [quickViewId, setQuickViewId] = useState<string | null>(null);
  const quickViewTriggerRef = useRef<HTMLElement | null>(null);
  // The row the panel was opened or stepped onto, kept so it can go on being
  // shown after it leaves the loaded page — the common case being a Tracking
  // status changed from the panel itself while that status is being filtered
  // on. It survived for free while every Analysis was in memory; now the page
  // is all there is, and taking the panel away would punish the action the
  // candidate just took. Written only by the events that hold the row, so no
  // effect has to chase the list.
  const [openedAnalysis, setOpenedAnalysis] = useState<AnalysisDetail | null>(null);

  const columnVisibility = useColumnVisibility(
    COLUMN_VISIBILITY_STORAGE_KEY,
    COLUMNS,
  );

  // Seven filters side by side pushed the table below the fold, so only the
  // search box and the status select stay out; the rest fold into a panel
  // under "Plus de filtres". It starts open when the URL already carries one
  // of the folded-away filters, so a shared or refreshed link shows what is
  // narrowing the table rather than hiding it behind a closed panel.
  const advancedFilterCount = activeAdvancedFilterCount(state);
  const [filtersOpen, setFiltersOpen] = useState(() => advancedFilterCount > 0);


  // `updateState` patches whatever the table state is *when it runs*, not when
  // it was created. The two debounced text filters commit from a timer, so the
  // state they closed over can be several changes old by then: typing a search
  // term and then ticking a platform used to end with the platform quietly
  // dropped when the search landed on top of it.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Any change to a filter, sort or page size resets `page` to 1 — a stale
  // page number from before the change would otherwise show an empty or
  // truncated table. Passing `page` explicitly (the pager buttons) opts out.
  const updateState = useCallback(
    (patch: Partial<AnalysesTableState>) => {
      const next: AnalysesTableState = {
        ...stateRef.current,
        ...patch,
        page: patch.page ?? 1,
      };
      const qs = analysesTableStateToParams(next).toString();
      router.replace(`${pathname}?${qs}`, { scroll: false });
      // The selection is the page's, so anything that changes which rows are
      // on it empties the selection — including the page itself, which used
      // to be the one change that left it alone, back when every row was in
      // memory and a selection could span pages (docs/adr/0033).
      setSelectedIds(new Set());
      setBulkError(null);
      setBulkNotice(null);
      setBulkGenerateConfirming(null);
      setBulkGenerationDocumentIds([]);
      setBulkRelaunchConfirming(false);
    },
    // No `state`: it is read through `stateRef` precisely so a patch applies
    // to the newest one, and listing it here would rebuild this on every
    // filter change for nothing.
    [router, pathname],
  );

  // The two free-text filters commit on a pause rather than on every
  // keystroke — see `useDebouncedField`.
  const [searchDraft, setSearchDraft] = useDebouncedField(
    state.search,
    (search) => updateState({ search }),
  );
  const [locationDraft, setLocationDraft] = useDebouncedField(
    state.location,
    (location) => updateState({ location }),
  );

  // --- Quick view navigation ---
  // The arrows walk the whole filtered, sorted list, not the current page:
  // stopping every 25 rows would reinstate the very "close the panel to see
  // another one" friction they exist to remove. Crossing a page boundary
  // flips the table behind the panel, so the list and the panel never
  // disagree about where the candidate is — and, since the list became one
  // page at a time (docs/adr/0033), fetches that page on the way.
  //
  // Every index here is a rank in the *whole* filtered list, not an offset
  // into the loaded page; `firstRowIndex` converts between the two.
  const firstRowIndex = (page - 1) * state.pageSize;

  // The slot the panel occupies. It is what "suivant" resumes from when the
  // Analysis itself has left the list, and what a page-crossing step resolves
  // against once the new page lands. Only ever written by the two events that
  // know the slot for certain — opening a row and stepping with the arrows.
  const [quickViewAnchor, setQuickViewAnchor] = useState(0);

  // Which Analysis the panel shows, in the two ways it can be identified.
  // Normally by id. But an arrow that crosses a page boundary knows only the
  // rank it asked for — the row itself arrives a request later — so it clears
  // the id and the panel resolves the rank against whatever page comes back.
  const quickViewAnalysis =
    (quickViewId === null
      ? rows[quickViewAnchor - firstRowIndex]
      : (rows.find((a) => a.id === quickViewId) ??
        (openedAnalysis?.id === quickViewId ? openedAnalysis : undefined))) ?? null;

  const quickViewIndex = quickViewAnalysis
    ? (() => {
        const rowIndex = rows.findIndex((a) => a.id === quickViewAnalysis.id);
        return rowIndex === -1 ? -1 : firstRowIndex + rowIndex;
      })()
    : -1;

  const openQuickViewAt = (
    analysis: AnalysisDetail,
    rowIndex: number,
    element: HTMLElement,
  ) => {
    quickViewTriggerRef.current = element;
    setQuickViewOpen(true);
    setQuickViewId(analysis.id);
    setOpenedAnalysis(analysis);
    setQuickViewAnchor(firstRowIndex + rowIndex);
  };

  // Dropping the panel's own Analysis shifts everything after it down one
  // slot, so the anchor already points at what "suivant" should show.
  const previousIndex =
    quickViewIndex >= 0 ? quickViewIndex - 1 : quickViewAnchor - 1;
  const nextIndex = quickViewIndex >= 0 ? quickViewIndex + 1 : quickViewAnchor;
  const hasPreviousAnalysis = quickViewOpen && previousIndex >= 0;
  const hasNextAnalysis = quickViewOpen && nextIndex < total;

  const goToAnalysisAt = (index: number) => {
    if (index < 0 || index >= total) return;
    setQuickViewAnchor(index);
    const targetPage = Math.floor(index / state.pageSize) + 1;
    if (targetPage === page) {
      const target = rows[index - firstRowIndex];
      if (!target) return;
      setQuickViewId(target.id);
      setOpenedAnalysis(target);
      return;
    }
    // Off this page: ask for the one holding it, and let the panel resolve the
    // rank when it lands. It stays open on the row it was showing meanwhile —
    // it already renders a loading state, and blanking it mid-step would be
    // worse than a beat of delay.
    setQuickViewId(null);
    updateState({ page: targetPage });
  };

  // Radix hands focus back to whatever `quickViewTriggerRef` names when the
  // panel closes. Keep it on the row actually *shown*: after a few "suivant"
  // the row that opened the panel may be on another page and unmounted, and
  // focus would land nowhere. Depends on `rows` too, so it finds the row once
  // a page flip has rendered it.
  const shownAnalysisId = quickViewAnalysis?.id ?? null;
  useEffect(() => {
    if (shownAnalysisId === null) return;
    const row = document.querySelector<HTMLElement>(
      `[data-analysis-id="${shownAnalysisId}"]`,
    );
    if (row) quickViewTriggerRef.current = row;
  }, [shownAnalysisId, rows]);

  const pageIds = useMemo(() => rows.map((a) => a.id), [rows]);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  // Only ever rows on screen: every bulk action needs the row itself, not just
  // its id — which is terminal, which is stuck, which still needs a document,
  // and the fields the CSV export writes — and off-page rows are no longer in
  // memory to ask (docs/adr/0033).
  const selectedAnalyses = useMemo(
    () => rows.filter((a) => selectedIds.has(a.id)),
    [rows, selectedIds],
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

  const handleBulkStatusChange = (applicationStatus: (typeof TRACKING_STATUS_TRANSITIONS)[number]["applicationStatus"]) => {
    setBulkError(null);
    setBulkNotice(null);
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

  // What each button would actually create, so the confirm step can price the
  // run at what it costs (one document per eligible row) rather than at the
  // old flat "selection × 2" — and name what it is leaving out.
  const generationTargets = useMemo(
    () => ({
      COVER_LETTER: selectedAnalyses.filter((a) =>
        needsGeneratedDocument(a, "COVER_LETTER"),
      ),
      TAILORED_CV: selectedAnalyses.filter((a) =>
        needsGeneratedDocument(a, "TAILORED_CV"),
      ),
    }),
    [selectedAnalyses],
  );

  // The mutation is shared by both buttons, so which document is in flight is
  // read off the variables it was called with rather than from `isPending`
  // alone — otherwise one run would grey out the other's button.
  const inFlightGenerationType = bulkCreateGeneratedDocuments.isPending
    ? (bulkCreateGeneratedDocuments.variables?.type ?? null)
    : null;

  const requiredGenerationDocs = bulkGenerateConfirming
    ? generationTargets[bulkGenerateConfirming].length
    : 0;
  const skippedGenerationCount = selectedIds.size - requiredGenerationDocs;
  const remainingGenerationQuota = quotas?.documentsDaily.remaining;
  const insufficientGenerationQuota =
    remainingGenerationQuota != null && requiredGenerationDocs > remainingGenerationQuota;

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
    if (bulkGenerateConfirming === null) return;
    setBulkError(null);
    setBulkNotice(null);
    const type = bulkGenerateConfirming;
    const analysisIds = generationTargets[type].map((a) => a.id);
    bulkCreateGeneratedDocuments.mutate(
      { analysisIds, type },
      {
        onSuccess: ({ failedAnalysisIds, documentIds }) => {
          // Only closes the panel if it is still this run's — the other
          // button stays live while this one is in flight, and a candidate
          // who used it meanwhile shouldn't have their confirm snatched away.
          setBulkGenerateConfirming((current) =>
            current === type ? null : current,
          );
          setBulkGenerationDocumentIds((current) => [...current, ...documentIds]);
          // The rows' own document-status columns decide what is still
          // eligible, so they have to catch up — otherwise a second click on
          // the same button would offer to pay for the rows just queued.
          queryClient.invalidateQueries({ queryKey: ["analyses"] });
          if (failedAnalysisIds.length > 0) {
            setBulkError(
              t("bulk.generatePartialError", {
                failed: failedAnalysisIds.length,
                total: analysisIds.length,
              }),
            );
          }
        },
      },
    );
  };

  const eligibleForRelaunch = useMemo(
    () => selectedAnalyses.filter((a) => TERMINAL_ANALYSIS_STATUSES.has(a.status)),
    [selectedAnalyses],
  );
  const eligibleRelaunchCount = eligibleForRelaunch.length;
  const skippedRelaunchCount = selectedIds.size - eligibleRelaunchCount;
  const remainingAnalysisQuota = quotas?.analysesDaily.remaining;
  const insufficientRelaunchQuota =
    remainingAnalysisQuota != null && eligibleRelaunchCount > remainingAnalysisQuota;

  const handleConfirmBulkRelaunch = () => {
    setBulkError(null);
    setBulkNotice(null);
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

  // Bulk requeue (docs/adr/0032): the repair for rows a worker or queue restart
  // orphaned, which strands them by the dozen — the originating incident left
  // 22 — while the only route was one Quick view at a time. Unlike the relaunch
  // above it needs no confirm step and no quota arithmetic: it re-drives the
  // same rows and charges nothing. `stuck` is the server's own verdict, so the
  // eligible subset is read off the rows rather than re-derived here.
  const eligibleForRequeue = useMemo(
    () => selectedAnalyses.filter((a) => a.stuck),
    [selectedAnalyses],
  );
  const eligibleRequeueCount = eligibleForRequeue.length;

  const handleBulkRequeue = () => {
    setBulkError(null);
    setBulkNotice(null);
    const ids = eligibleForRequeue.map((a) => a.id);
    // The button is offered on any selection now, so the "nothing to pick up
    // here" case is answered in words rather than by a button that looks
    // broken. There is no confirm step to carry the explanation (a Requeue
    // costs nothing and asks nothing), so it lands as a plain notice.
    if (ids.length === 0) {
      setBulkNotice(t("bulk.requeueNoneEligible"));
      return;
    }
    bulkRequeueAnalyses.mutate(ids, {
      onSuccess: ({ failedAnalysisIds }) => {
        if (failedAnalysisIds.length > 0) {
          setBulkError(
            t("bulk.requeuePartialError", {
              failed: failedAnalysisIds.length,
              total: ids.length,
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

  // A filter that matches nothing now returns an empty page, which used to be
  // indistinguishable from "this candidate has no analyses" — and which hid
  // the filter panel, and with it the only way back out (docs/adr/0033). The
  // filters are shown whenever one is set, whatever came back.
  const filtering = hasActiveFilters(state);
  const showFilters = filtering || total > 0;
  const showEmptyState = !isPending && !isError && total === 0;

  // Below ~640px the table becomes cramped even with every collapsible
  // column dropped (#69), so it's replaced outright by a stacked card per
  // Analysis carrying the same fields and click/select/link behaviors.
  const isCardLayout = useMediaQuery("(max-width: 639px)");

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-2">
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
            <RefreshCw
              aria-hidden="true"
              className={isFetching ? "animate-spin" : undefined}
            />
            {t("refresh")}
          </Button>
        </div>
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

      {showEmptyState && !filtering && (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}

      {showFilters && (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-panel/40 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex flex-col gap-1.5 lg:flex-1">
              <Label htmlFor="analyses-search">{t("controls.searchLabel")}</Label>
              <Input
                id="analyses-search"
                type="search"
                placeholder={t("controls.searchPlaceholder")}
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5 lg:w-56">
              <Label id="analyses-status-label" htmlFor="analyses-status">
                {t("controls.statusLabel")}
              </Label>
              <CheckboxFilterMenu
                id="analyses-status"
                labelId="analyses-status-label"
                emptyLabel={t("controls.statusAll")}
                values={ANALYSES_STATUS_FILTERS}
                selected={state.status}
                onChange={(status) => updateState({ status })}
                valueLabel={(status) =>
                  isPipelineStatusFilter(status)
                    ? pipelineStatusLabel(status)
                    : trackingStatusLabel(status)
                }
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
                aria-controls="analyses-advanced-filters"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal aria-hidden="true" />
                {advancedFilterCount > 0
                  ? t("controls.moreFiltersActive", { count: advancedFilterCount })
                  : t("controls.moreFilters")}
                <ChevronDown
                  aria-hidden="true"
                  className={
                    filtersOpen
                      ? "rotate-180 transition-transform"
                      : "transition-transform"
                  }
                />
              </Button>
              {hasActiveFilters(state) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => updateState(DEFAULT_ANALYSES_FILTERS)}
                >
                  <X aria-hidden="true" />
                  {t("controls.clearFilters")}
                </Button>
              )}
            </div>
          </div>

          {filtersOpen && (
            <div
              id="analyses-advanced-filters"
              className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analyses-requested-from">{t("controls.requestedAtFromLabel")}</Label>
                <Input
                  id="analyses-requested-from"
                  type="date"
                  value={state.requestedAtFrom}
                  onChange={(event) => updateState({ requestedAtFrom: event.target.value })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analyses-requested-to">{t("controls.requestedAtToLabel")}</Label>
                <Input
                  id="analyses-requested-to"
                  type="date"
                  value={state.requestedAtTo}
                  onChange={(event) => updateState({ requestedAtTo: event.target.value })}
                />
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
                  {/* A label the URL carries but the list no longer offers —
                      the last analysis using that CV was deleted, say — would
                      leave the select showing a value with no option and read
                      as "Tous les CV" while still narrowing the table. */}
                  {state.cvLabel !== "all" &&
                    !(cvLabels ?? []).includes(state.cvLabel) && (
                      <option value={state.cvLabel}>{state.cvLabel}</option>
                    )}
                  {(cvLabels ?? []).map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label id="analyses-platform-label" htmlFor="analyses-platform">
                  {t("controls.platformLabel")}
                </Label>
                <CheckboxFilterMenu
                  id="analyses-platform"
                  labelId="analyses-platform-label"
                  emptyLabel={t("controls.platformAll")}
                  values={JOB_OFFER_SOURCE_SITES}
                  selected={state.platform}
                  onChange={(platform) => updateState({ platform })}
                  valueLabel={sourceSiteLabel}
                  countLabel={(count) => t("controls.platformCount", { count })}
                  clearLabel={t("controls.clearThisFilter")}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analyses-location">{t("controls.locationLabel")}</Label>
                <Input
                  id="analyses-location"
                  type="search"
                  placeholder={t("controls.locationPlaceholder")}
                  value={locationDraft}
                  onChange={(event) => setLocationDraft(event.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {showEmptyState && filtering && (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      )}

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
          <span className="text-sm font-medium">
            {t("bulk.selectedCount", { count: selectedIds.size })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedIds(new Set());
              setBulkError(null);
              setBulkNotice(null);
              setBulkGenerateConfirming(null);
              setBulkGenerationDocumentIds([]);
              setBulkRelaunchConfirming(false);
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
            {/* One button per document rather than the old pair-at-once:
                asking for a letter alone used to bill a tailored CV nobody
                wanted (docs/adr/0031). Only the one being generated goes
                disabled, so the two are independent here as they are in the
                Quick view's panel. */}
            {GENERATION_BUTTONS.map(({ type, labelKey }) => (
              <Button
                key={type}
                type="button"
                variant="outline"
                size="sm"
                disabled={inFlightGenerationType === type}
                onClick={() => {
                  setBulkRelaunchConfirming(false);
                  setBulkGenerateConfirming(type);
                }}
              >
                {inFlightGenerationType === type ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles aria-hidden="true" />
                )}
                {td(labelKey)}
              </Button>
            ))}
            {/* Stays live on any selection: a greyed button with nothing
                saying why was read as the action being broken, when what it
                meant was "nothing here is finished yet". The confirmation
                below carries that sentence instead. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkCreateAnalyses.isPending}
              onClick={() => {
                setBulkGenerateConfirming(null);
                setBulkRelaunchConfirming(true);
              }}
            >
              <RotateCw aria-hidden="true" />
              {td("retry")}
            </Button>
            {/* Offered on any selection too, for the same reason — and it is
                no longer the second button in this bar saying "Relancer
                l'analyse": a Requeue re-drives the same row for free, a
                Re-run buys a new one (services/api's own glossary lists
                Relaunch under Requeue's _Avoid_). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkRequeueAnalyses.isPending}
              onClick={handleBulkRequeue}
            >
              {bulkRequeueAnalyses.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <RotateCw aria-hidden="true" />
              )}
              {t("bulk.requeue", { count: eligibleRequeueCount })}
            </Button>
          </div>
          {bulkError && (
            <p role="alert" className="w-full text-sm text-destructive">
              {bulkError}
            </p>
          )}
          {bulkNotice && (
            <p role="status" className="w-full text-sm text-muted">
              {bulkNotice}
            </p>
          )}
          {bulkGenerateConfirming !== null && (
            <div className="flex w-full flex-col gap-2 rounded-md border border-border bg-background p-3">
              {/* Prices the run at what it will actually create and names what
                  it leaves behind — a selection can hold rows still running,
                  and rows that already have this document. */}
              <p className="text-sm">
                {requiredGenerationDocs === 0
                  ? t("bulk.generateNoneEligible", {
                      document: t(`bulk.document.${bulkGenerateConfirming}`),
                    })
                  : skippedGenerationCount > 0
                    ? t("bulk.generateConfirmMixed", {
                        document: t(`bulk.document.${bulkGenerateConfirming}`),
                        count: requiredGenerationDocs,
                        skipped: skippedGenerationCount,
                        remaining: remainingGenerationQuota ?? 0,
                      })
                    : t("bulk.generateConfirm", {
                        document: t(`bulk.document.${bulkGenerateConfirming}`),
                        count: requiredGenerationDocs,
                        remaining: remainingGenerationQuota ?? 0,
                      })}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    requiredGenerationDocs === 0 ||
                    insufficientGenerationQuota ||
                    inFlightGenerationType === bulkGenerateConfirming
                  }
                  onClick={handleConfirmBulkGenerate}
                >
                  {inFlightGenerationType === bulkGenerateConfirming ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {t("bulk.generateConfirmAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBulkGenerateConfirming(null)}
                >
                  <X aria-hidden="true" />
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
                {eligibleRelaunchCount === 0
                  ? t("bulk.relaunchNoneEligible")
                  : skippedRelaunchCount > 0
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
                  disabled={
                    eligibleRelaunchCount === 0 ||
                    insufficientRelaunchQuota ||
                    bulkCreateAnalyses.isPending
                  }
                  onClick={handleConfirmBulkRelaunch}
                >
                  {bulkCreateAnalyses.isPending ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {t("bulk.generateConfirmAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBulkRelaunchConfirming(false)}
                >
                  <X aria-hidden="true" />
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

      {rows.length > 0 && (
        <>
          {isCardLayout ? (
            <div className="flex flex-col gap-3">
              {rows.map((analysis, rowIndex) => (
                <AnalysisCard
                  key={analysis.id}
                  analysis={analysis}
                  sourceSiteLabel={sourceSiteLabel}
                  pipelineStatusLabel={pipelineStatusLabel}
                  trackingStatusLabel={trackingStatusLabel}
                  generatedDocumentStatusLabel={generatedDocumentStatusLabel}
                  tailoredCvLabel={td("generatedDocuments.tailoredCv")}
                  coverLetterLabel={td("generatedDocuments.coverLetter")}
                  linkLabel={t("columns.linkLabel")}
                  jobOfferFallback={t("jobOfferFallback")}
                  selected={selectedIds.has(analysis.id)}
                  selectLabel={t("bulk.selectRowLabel", {
                    title: analysis.jobOffer.title ?? t("jobOfferFallback"),
                  })}
                  onToggleSelect={() => toggleRowSelection(analysis.id)}
                  onOpenQuickView={(row) =>
                    openQuickViewAt(analysis, rowIndex, row)
                  }
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
                  {COLUMNS.filter((column) =>
                    columnVisibility.isVisible(column.key),
                  ).map((column) => (
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
                {rows.map((analysis, rowIndex) => (
                  <AnalysisTableRow
                    key={analysis.id}
                    analysis={analysis}
                    isColumnVisible={columnVisibility.isVisible}
                    sourceSiteLabel={sourceSiteLabel}
                    pipelineStatusLabel={pipelineStatusLabel}
                    trackingStatusLabel={trackingStatusLabel}
                    generatedDocumentStatusLabel={generatedDocumentStatusLabel}
                    linkLabel={t("columns.linkLabel")}
                    jobOfferFallback={t("jobOfferFallback")}
                    copyIdLabel={t("columns.copyId")}
                    selected={selectedIds.has(analysis.id)}
                    selectLabel={t("bulk.selectRowLabel", {
                      title: analysis.jobOffer.title ?? t("jobOfferFallback"),
                    })}
                    onToggleSelect={() => toggleRowSelection(analysis.id)}
                    onOpenQuickView={(row) =>
                      openQuickViewAt(analysis, rowIndex, row)
                    }
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

      <AnalysisQuickView
        analysis={quickViewAnalysis}
        // Its own state, not `quickViewAnalysis !== null`: right after a
        // successful relaunch (#124), and for the beat after an arrow crosses
        // a page boundary, the panel has no row to show yet — and Radix would
        // read that as a close, mirroring the CV-versions panel's Replace flow.
        open={quickViewOpen}
        onOpenChange={(open) => {
          if (open) return;
          setQuickViewOpen(false);
          setQuickViewId(null);
          setOpenedAnalysis(null);
        }}
        pipelineStatusLabel={pipelineStatusLabel}
        trackingStatusLabel={trackingStatusLabel}
        returnFocusRef={quickViewTriggerRef}
        onRelaunched={(newId) => setQuickViewId(newId)}
        position={quickViewIndex >= 0 ? quickViewIndex + 1 : null}
        total={total}
        hasPrevious={hasPreviousAnalysis}
        hasNext={hasNextAnalysis}
        onPrevious={() => goToAnalysisAt(previousIndex)}
        onNext={() => goToAnalysisAt(nextIndex)}
      />
    </main>
  );
}

function AnalysisTableRow({
  analysis,
  isColumnVisible,
  sourceSiteLabel,
  pipelineStatusLabel,
  trackingStatusLabel,
  generatedDocumentStatusLabel,
  linkLabel,
  jobOfferFallback,
  copyIdLabel,
  selected,
  selectLabel,
  onToggleSelect,
  onOpenQuickView,
}: {
  analysis: AnalysisSummary;
  isColumnVisible: (column: AnalysesSortColumn) => boolean;
  sourceSiteLabel: (value: string) => string;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  generatedDocumentStatusLabel: (value: string) => string;
  linkLabel: string;
  jobOfferFallback: string;
  copyIdLabel: string;
  selected: boolean;
  selectLabel: string;
  onToggleSelect: () => void;
  onOpenQuickView: (row: HTMLTableRowElement) => void;
}) {
  return (
    <TableRow
      // How the page finds this row again to hand focus back once the Quick
      // view closes — the arrows can have walked to another page since.
      data-analysis-id={analysis.id}
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
        <TruncatedCell
          text={analysis.jobOffer.title ?? jobOfferFallback}
          maxLength={TITLE_MAX_LENGTH}
        />
      </TableCell>
      {isColumnVisible("id") && (
        <TableCell>
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs text-muted">{analysis.id}</span>
            <CopyIdButton value={analysis.id} label={copyIdLabel} />
          </div>
        </TableCell>
      )}
      {isColumnVisible("company") && (
        <TableCell>
          {analysis.jobOffer.company ? (
            <TruncatedCell
              text={analysis.jobOffer.company}
              maxLength={SHORT_FIELD_MAX_LENGTH}
            />
          ) : (
            "—"
          )}
        </TableCell>
      )}
      {isColumnVisible("location") && (
        <TableCell>
          {analysis.jobOffer.location ? (
            <TruncatedCell
              text={analysis.jobOffer.location}
              maxLength={SHORT_FIELD_MAX_LENGTH}
            />
          ) : (
            "—"
          )}
        </TableCell>
      )}
      {isColumnVisible("sourceSite") && (
        <TableCell>{sourceSiteLabel(analysis.jobOffer.sourceSite)}</TableCell>
      )}
      {isColumnVisible("postedAt") && (
        <TableCell>
          {analysis.jobOffer.postedAt
            ? new Date(analysis.jobOffer.postedAt).toLocaleDateString()
            : "—"}
        </TableCell>
      )}
      {isColumnVisible("requestedAt") && (
        <TableCell>{new Date(analysis.requestedAt).toLocaleDateString()}</TableCell>
      )}
      {isColumnVisible("cvLabel") && (
        <TableCell>{analysis.cvVersion.label}</TableCell>
      )}
      {isColumnVisible("matchScore") && (
        <TableCell className="text-right tabular-nums">
          {analysis.matchScore ?? "—"}
        </TableCell>
      )}
      {isColumnVisible("tailoredCvStatus") && (
        <TableCell>
          <GeneratedDocumentStatusBadge
            status={analysis.tailoredCvStatus}
            label={generatedDocumentStatusLabel}
          />
        </TableCell>
      )}
      {isColumnVisible("coverLetterStatus") && (
        <TableCell>
          <GeneratedDocumentStatusBadge
            status={analysis.coverLetterStatus}
            label={generatedDocumentStatusLabel}
          />
        </TableCell>
      )}
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
  generatedDocumentStatusLabel,
  tailoredCvLabel,
  coverLetterLabel,
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
  generatedDocumentStatusLabel: (value: string) => string;
  tailoredCvLabel: string;
  coverLetterLabel: string;
  linkLabel: string;
  jobOfferFallback: string;
  selected: boolean;
  selectLabel: string;
  onToggleSelect: () => void;
  onOpenQuickView: (row: HTMLDivElement) => void;
}) {
  return (
    <div
      data-analysis-id={analysis.id}
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
        <span className="flex items-center gap-1">
          <span className="text-muted">{tailoredCvLabel}:</span>
          <GeneratedDocumentStatusBadge
            status={analysis.tailoredCvStatus}
            label={generatedDocumentStatusLabel}
          />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-muted">{coverLetterLabel}:</span>
          <GeneratedDocumentStatusBadge
            status={analysis.coverLetterStatus}
            label={generatedDocumentStatusLabel}
          />
        </span>
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

function generatedDocumentStatusBadgeVariant(
  status: GeneratedDocumentStatus,
): "secondary" | "warning" | "success" | "destructive" {
  if (status === "READY") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "GENERATING") return "warning";
  return "secondary";
}

/** Renders a status Badge for a Tailored CV/Cover letter GeneratedDocument, or
 *  a plain "—" when generation was never triggered for that Analysis. */
function GeneratedDocumentStatusBadge({
  status,
  label,
}: {
  status: GeneratedDocumentStatus | null;
  label: (value: string) => string;
}) {
  if (status === null) return <span className="text-muted">—</span>;
  return (
    <Badge variant={generatedDocumentStatusBadgeVariant(status)}>
      {label(status)}
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
