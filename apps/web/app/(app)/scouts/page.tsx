"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, RefreshCw } from "lucide-react";

import { useScouts, type ScoutStatus } from "@/hooks/use-scouts";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import {
  DEFAULT_SCOUTS_SORT,
  sortScouts,
  type ScoutsSortColumn,
  type ScoutsSortState,
} from "@/lib/scouts-sort";
import type { ColumnConfig } from "@/lib/column-visibility";
import { TITLE_MAX_LENGTH } from "@/lib/text-truncation";
import { SortableHead } from "@/components/sortable-head";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { TruncatedCell } from "@/components/truncated-cell";
import { CopyIdButton } from "@/components/copy-id-button";
import { ScoutPanel } from "@/components/scout-panel";
import { ScoutRunStateBadge } from "@/components/scout-run-state-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Label is the always-visible primary column (#131), reusing
// lib/column-visibility.ts, hooks/use-column-visibility.ts, and
// components/column-visibility-menu.tsx unmodified, same as CV versions
// (#130) and Analyses (#129).
const COLUMNS: ColumnConfig<ScoutsSortColumn>[] = [
  { key: "label", labelKey: "list.columns.label", hideable: false },
  {
    key: "id",
    labelKey: "list.columns.id",
    hideable: true,
    defaultVisible: false,
  },
  { key: "status", labelKey: "list.columns.status", hideable: true },
  // Execution (#226) sits right after Status: lifecycle beside activity, read
  // together (docs/adr/0033).
  { key: "runState", labelKey: "list.columns.runState", hideable: true },
  { key: "baseCv", labelKey: "list.columns.baseCv", hideable: true },
  { key: "sites", labelKey: "list.columns.sites", hideable: true },
  { key: "lastRun", labelKey: "list.columns.lastRun", hideable: true },
  {
    key: "relevantFinds",
    labelKey: "list.columns.relevantFinds",
    hideable: true,
    className: "text-right",
  },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:scouts";

function statusVariant(
  status: ScoutStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PAUSED") return "warning";
  return "secondary";
}

function ScoutsPageContent() {
  const t = useTranslations("scouts");
  const {
    data: scouts,
    dataUpdatedAt,
    isPending,
    isError,
    isFetching,
    refetch,
  } = useScouts({ pollWhileInFlight: true });
  const { data: cvVersions } = useCvVersions();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Archived Scouts are hidden by default (issue #90); the toggle reveals
  // them again, mirroring cv-versions' showSuperseded checkbox. The toggle
  // doesn't affect sorting — filtering happens before sortScouts runs.
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<ScoutsSortState>(DEFAULT_SCOUTS_SORT);
  // The Scout panel's open Scout is local state (an id), same pattern as
  // CvVersionsPage's `panelId` (issue #81) — looked up against the live
  // fetched list each render, not a snapshot, so it resolves even for an
  // Archived Scout that `visibleScouts` is currently hiding. Not URL-synced
  // in general, but a `?open=<id>` link elsewhere in the app (the Edit-Scout
  // page, the post-edit redirect, an Application's "view Scout" back-link —
  // issue #92, now that `/scouts/[id]` is gone) seeds the initial value from
  // whatever `?open=` the page was reached with, read once via the lazy
  // initializer rather than an effect + setState.
  const [panelId, setPanelId] = useState<string | null>(() =>
    searchParams.get("open"),
  );
  const panelTriggerRef = useRef<HTMLElement | null>(null);
  const columnVisibility = useColumnVisibility(
    COLUMN_VISIBILITY_STORAGE_KEY,
    COLUMNS,
  );

  // Strips a consumed `?open=` from the URL so it doesn't reopen the panel
  // again on a later visit (e.g. navigating back). Only a router call, no
  // setState, since the initial `panelId` above already captured the value.
  useEffect(() => {
    if (searchParams.get("open")) {
      router.replace(pathname, { scroll: false });
    }
    // Runs once, against whatever `?open=` the page mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSort = (column: ScoutsSortColumn) => {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  };

  const cvLabelById = new Map(cvVersions?.map((cv) => [cv.id, cv.label]));
  const cvLabel = (id: string) => cvLabelById.get(id) ?? id;

  const visibleScouts = showArchived
    ? scouts
    : scouts?.filter((scout) => scout.status !== "ARCHIVED");

  // Sorting (#89) is applied client-side to the already-filtered list, same
  // shape as `sortCvVersions` on the cv-versions table.
  const sortedScouts = visibleScouts
    ? sortScouts(visibleScouts, sort, cvLabelById)
    : undefined;

  const panelScout = scouts?.find((scout) => scout.id === panelId) ?? null;

  const visibleColumns = COLUMNS.filter((column) =>
    columnVisibility.isVisible(column.key),
  );

  const openPanel = (row: HTMLTableRowElement, id: string) => {
    panelTriggerRef.current = row;
    setPanelId(id);
  };

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("list.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ColumnVisibilityMenu
            columns={COLUMNS}
            isVisible={columnVisibility.isVisible}
            onToggle={columnVisibility.toggle}
            onReset={columnVisibility.reset}
            label={t("list.columnsLabel")}
            columnLabel={(labelKey) => t(labelKey)}
            resetLabel={t("list.columnsReset")}
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
            {t("list.refresh")}
          </Button>
          <Button asChild size="sm">
            <Link href="/scouts/new">
              <Plus aria-hidden="true" />
              {t("list.new")}
            </Link>
          </Button>
        </div>
      </div>

      <label className="flex items-center gap-2 self-end text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-border accent-accent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        {t("list.showArchived")}
      </label>

      {isPending && (
        <div
          role="status"
          aria-label={t("list.loading")}
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("list.loadError")}
        </p>
      )}

      {sortedScouts && sortedScouts.length === 0 && (
        <p className="text-sm text-muted">{t("list.empty")}</p>
      )}

      {sortedScouts && sortedScouts.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              {visibleColumns.map((column) => (
                <SortableHead
                  key={column.key}
                  column={column.key}
                  label={t(column.labelKey)}
                  className={column.className}
                  sort={sort}
                  onSort={toggleSort}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedScouts.map((scout) => (
              <TableRow
                key={scout.id}
                tabIndex={0}
                onClick={(event) => openPanel(event.currentTarget, scout.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openPanel(event.currentTarget, scout.id);
                  }
                }}
                className="cursor-pointer"
              >
                <TableCell className="font-medium">
                  <TruncatedCell text={scout.label} maxLength={TITLE_MAX_LENGTH} />
                </TableCell>
                {columnVisibility.isVisible("id") && (
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs text-muted">{scout.id}</span>
                      <CopyIdButton value={scout.id} label={t("list.columns.copyId")} />
                    </div>
                  </TableCell>
                )}
                {columnVisibility.isVisible("status") && (
                  <TableCell>
                    <Badge variant={statusVariant(scout.status)}>
                      {t(`status.${scout.status}`)}
                    </Badge>
                  </TableCell>
                )}
                {columnVisibility.isVisible("runState") && (
                  <TableCell>
                    {/* Judged against the fetch time, so the duration moves
                        with each refetch and never ticks on its own. */}
                    <ScoutRunStateBadge
                      runState={scout.runState}
                      runStateSince={scout.runStateSince}
                      now={dataUpdatedAt}
                    />
                  </TableCell>
                )}
                {columnVisibility.isVisible("baseCv") && (
                  <TableCell>{cvLabel(scout.cvVersionId)}</TableCell>
                )}
                {columnVisibility.isVisible("sites") && (
                  <TableCell>
                    {t("list.sites", { count: scout.targetSiteKeys.length })}
                  </TableCell>
                )}
                {columnVisibility.isVisible("lastRun") && (
                  <TableCell>
                    {scout.lastRunAt
                      ? new Date(scout.lastRunAt).toLocaleDateString()
                      : t("list.neverRun")}
                  </TableCell>
                )}
                {columnVisibility.isVisible("relevantFinds") && (
                  <TableCell className="text-right tabular-nums">
                    {scout.relevantFindsCount}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ScoutPanel
        scout={panelScout}
        cvLabel={panelScout ? cvLabel(panelScout.cvVersionId) : ""}
        open={panelId !== null}
        onOpenChange={(open) => {
          if (!open) setPanelId(null);
        }}
        returnFocusRef={panelTriggerRef}
      />
    </main>
  );
}

export default function ScoutsPage() {
  return (
    <Suspense fallback={null}>
      <ScoutsPageContent />
    </Suspense>
  );
}
