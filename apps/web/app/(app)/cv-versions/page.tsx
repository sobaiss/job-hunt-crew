"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";

import {
  useCvVersions,
  useConvertCvVersion,
  useSetDefaultCvVersion,
  useReplaceCvVersion,
} from "@/hooks/use-cv-versions";
import { useScouts } from "@/hooks/use-scouts";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import {
  DEFAULT_CV_VERSIONS_SORT,
  sortCvVersions,
  type CvVersionsSortColumn,
  type CvVersionsSortState,
} from "@/lib/cv-versions-sort";
import { conversionBadgeVariant, formatFileSize } from "@/lib/cv-versions-display";
import type { ColumnConfig } from "@/lib/column-visibility";
import { TITLE_MAX_LENGTH } from "@/lib/text-truncation";
import { useEnumLabel } from "@/lib/enum-labels";
import { CvVersionPanel } from "@/components/cv-version-panel";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { SortableHead } from "@/components/sortable-head";
import { TruncatedCell } from "@/components/truncated-cell";
import { CopyIdButton } from "@/components/copy-id-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Label is the always-visible primary column (#130); Actions is never part
// of the toggle. The rest are hideable, mirroring Analyses' Columns menu
// (#129), reusing lib/column-visibility.ts and components/
// column-visibility-menu.tsx unmodified.
const COLUMNS: ColumnConfig<CvVersionsSortColumn>[] = [
  { key: "label", labelKey: "list.columns.label", hideable: false },
  {
    key: "id",
    labelKey: "list.columns.id",
    hideable: true,
    defaultVisible: false,
  },
  { key: "file", labelKey: "list.columns.file", hideable: true },
  {
    key: "size",
    labelKey: "list.columns.size",
    hideable: true,
    className: "text-right",
  },
  { key: "uploaded", labelKey: "list.columns.uploaded", hideable: true },
  { key: "status", labelKey: "list.columns.status", hideable: true },
  { key: "default", labelKey: "list.columns.default", hideable: true },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:cv-versions";

export default function CvVersionsPage() {
  const t = useTranslations("cvVersions");
  const conversionStatusLabel = useEnumLabel("cvConversionStatus");

  const list = useCvVersions();
  const convert = useConvertCvVersion();
  const setDefault = useSetDefaultCvVersion();
  const replace = useReplaceCvVersion();
  const scouts = useScouts();
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [justReplacedId, setJustReplacedId] = useState<string | null>(null);
  const [sort, setSort] = useState<CvVersionsSortState>(
    DEFAULT_CV_VERSIONS_SORT,
  );
  // Issue #81: the CV panel's open CV is local state (an id), not
  // URL-synced — same pattern as AnalysesTable's `quickViewId` — and looked
  // up against the live fetched list each render, not a snapshot.
  const [panelId, setPanelId] = useState<string | null>(null);
  const panelTriggerRef = useRef<HTMLElement | null>(null);
  const columnVisibility = useColumnVisibility(
    COLUMN_VISIBILITY_STORAGE_KEY,
    COLUMNS,
  );

  const toggleSort = (column: CvVersionsSortColumn) => {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  };

  // Issue #78: after a successful replace, tell the candidate which Scouts (if
  // any) still reference the CVVersion that was just superseded — Scouts are
  // never repointed automatically (docs/adr/0005), so this is surfaced only,
  // with a link to each Scout's edit form.
  const affectedScouts = justReplacedId
    ? (scouts.data?.filter((scout) => scout.cvVersionId === justReplacedId) ??
      [])
    : [];

  // Default view excludes superseded CVVersions (issue #74); the toggle
  // (issue #75) reveals them again, each labeled with its replacement —
  // resolved from the full (unfiltered) list, since services/api always
  // returns every CVVersion regardless of this client-side filter.
  const visibleCvVersions = showSuperseded
    ? list.data
    : list.data?.filter((cv) => cv.supersededById === null);
  const labelById = new Map(list.data?.map((cv) => [cv.id, cv.label]));

  // Sorting (#80) is applied client-side to the already-filtered list, one
  // column at a time — the same shape as `sortAnalyses`.
  const sortedCvVersions = useMemo(
    () => (visibleCvVersions ? sortCvVersions(visibleCvVersions, sort) : undefined),
    [visibleCvVersions, sort],
  );

  const panelCv = list.data?.find((cv) => cv.id === panelId) ?? null;
  const panelReplacedByLabel = panelCv?.supersededById
    ? (labelById.get(panelCv.supersededById) ?? null)
    : null;

  const visibleColumns = COLUMNS.filter((column) =>
    columnVisibility.isVisible(column.key),
  );
  // +1 for the non-sortable Actions column, used as the expanded detail row's
  // colSpan (conversion error text; Replace lives in the panel since #82).
  // Recomputed from the currently visible columns (#130) rather than a fixed
  // constant, so a hidden column doesn't leave the spanned cell too wide.
  const tableColumnCount = visibleColumns.length + 1;

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-10 p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
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
            disabled={list.isFetching}
            onClick={() => list.refetch()}
          >
            <RefreshCw
              className={list.isFetching ? "size-4 animate-spin" : "size-4"}
            />
            {t("list.refresh")}
          </Button>
          <Button asChild size="sm">
            <Link href="/cv-versions/new">{t("list.importCv")}</Link>
          </Button>
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-serif text-xl font-semibold">
            {t("list.heading")}
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-accent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
            />
            {t("list.showSuperseded")}
          </label>
        </div>

        {affectedScouts.length > 0 && (
          <div role="alert" className="rounded-md border border-warning bg-warning/10 p-4 text-sm">
            <p className="font-medium">{t("list.scoutWarningHeading")}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {affectedScouts.map((scout) => (
                <li key={scout.id}>
                  <Link
                    href={`/scouts/${scout.id}/edit`}
                    className="text-accent underline"
                  >
                    {scout.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {list.isPending && (
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

        {list.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("list.loadError")}
          </p>
        )}

        {visibleCvVersions && visibleCvVersions.length === 0 && (
          <p className="text-sm text-muted">{t("list.empty")}</p>
        )}

        {setDefault.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("list.setDefaultError")}
          </p>
        )}
        {setDefault.isSuccess && (
          <p role="status" className="text-sm text-success">
            {t("list.setDefaultSuccess")}
          </p>
        )}
        {convert.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("list.convertError")}
          </p>
        )}

        {sortedCvVersions && sortedCvVersions.length > 0 && (
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
                <TableHead>{t("list.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedCvVersions.map((cv) => {
                const busy =
                  cv.conversionStatus === "CONVERTING" ||
                  (convert.isPending && convert.variables === cv.id);
                const showDetailRow = cv.conversionStatus === "FAILED";
                const openPanel = (row: HTMLTableRowElement) => {
                  panelTriggerRef.current = row;
                  setPanelId(cv.id);
                };

                return (
                  <Fragment key={cv.id}>
                    <TableRow
                      tabIndex={0}
                      onClick={(event) => openPanel(event.currentTarget)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openPanel(event.currentTarget);
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-medium">
                        <TruncatedCell text={cv.label} maxLength={TITLE_MAX_LENGTH} />
                      </TableCell>
                      {columnVisibility.isVisible("id") && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-xs text-muted">{cv.id}</span>
                            <CopyIdButton value={cv.id} label={t("list.columns.copyId")} />
                          </div>
                        </TableCell>
                      )}
                      {columnVisibility.isVisible("file") && (
                        <TableCell>
                          <TruncatedCell text={cv.fileName} maxLength={TITLE_MAX_LENGTH} /> · {cv.fileType}
                        </TableCell>
                      )}
                      {columnVisibility.isVisible("size") && (
                        <TableCell className="text-right tabular-nums">
                          {formatFileSize(cv.fileSizeBytes)}
                        </TableCell>
                      )}
                      {columnVisibility.isVisible("uploaded") && (
                        <TableCell>
                          {new Date(cv.createdAt).toLocaleDateString()}
                        </TableCell>
                      )}
                      {columnVisibility.isVisible("status") && (
                        <TableCell>
                          <Badge
                            variant={conversionBadgeVariant(cv.conversionStatus)}
                          >
                            {conversionStatusLabel(cv.conversionStatus)}
                          </Badge>
                        </TableCell>
                      )}
                      {columnVisibility.isVisible("default") && (
                        <TableCell>
                          {cv.isDefault ? (
                            <Badge variant="outline">{t("list.default")}</Badge>
                          ) : cv.supersededById ? (
                            <span className="text-xs text-muted">
                              {t("list.replacedBy", {
                                label: labelById.get(cv.supersededById) ?? "",
                              })}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      )}
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => convert.mutate(cv.id)}
                            disabled={busy}
                          >
                            {busy
                              ? t("list.converting")
                              : cv.conversionStatus === "CONVERTED"
                                ? t("list.reconvert")
                                : t("list.convert")}
                          </Button>
                          {!cv.isDefault && !cv.supersededById && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setDefault.mutate(cv.id)}
                              disabled={
                                setDefault.isPending &&
                                setDefault.variables === cv.id
                              }
                            >
                              {setDefault.isPending &&
                              setDefault.variables === cv.id
                                ? t("list.settingDefault")
                                : t("list.setDefault")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {showDetailRow && (
                      <TableRow>
                        <TableCell colSpan={tableColumnCount}>
                          <p role="alert" className="text-sm text-destructive">
                            {t("list.conversionFailed")}
                            {cv.conversionError ? ` ${cv.conversionError}` : ""}
                          </p>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <CvVersionPanel
        cv={panelCv}
        replacedByLabel={panelReplacedByLabel}
        // `panelId !== null` (not `panelCv !== null`): right after a
        // successful Replace the panel switches to the new id (#82) before
        // the invalidated list query has refetched it, so `panelCv` is
        // briefly null — checking `panelId` keeps the Sheet open through
        // that gap instead of having Radix treat it as a close.
        open={panelId !== null}
        onOpenChange={(open) => {
          if (!open) setPanelId(null);
        }}
        returnFocusRef={panelTriggerRef}
        conversionStatusLabel={conversionStatusLabel}
        convert={convert}
        setDefault={setDefault}
        replace={replace}
        onReplaced={(oldId, newId) => {
          setJustReplacedId(oldId);
          setPanelId(newId);
        }}
      />
    </main>
  );
}
