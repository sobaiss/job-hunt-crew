"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  useAnalyses,
  type AnalysisSummary,
} from "@/hooks/use-analyses";
import { useSiteConfigs } from "@/hooks/use-site-configs";
import {
  ANALYSIS_STATUSES,
  cvLabelsOf,
  filterAnalyses,
  DEFAULT_ANALYSES_FILTERS,
  type AnalysesFilterState,
} from "@/lib/analyses-filters";
import { useEnumLabel } from "@/lib/enum-labels";
import { AnalysisRow } from "@/components/analysis-row";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

// A styled native <select>: mirrors the matching-flow forms' SELECT_CLASS so
// the app reads as one system, and stays trivial to drive with user-event.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A Dashboard row: either one standalone Analysis, or a whole SITE_SEARCH
 * IngestionJob's batch folded into one grouped row (issue #34). Every
 * `mode === "SITE_SEARCH"` Analysis with an `ingestionJobId` is grouped; a
 * `SINGLE_URL` Analysis or one with `ingestionJobId === null` stays a single
 * row. Ordering follows the API's recency ordering — a group takes the slot of
 * its most recent (first-seen) Analysis.
 */
type DashboardRow =
  | { kind: "single"; analysis: AnalysisSummary }
  | {
      kind: "batch";
      ingestionJobId: string;
      siteConfigId: string | null;
      analyses: AnalysisSummary[];
    };

function groupRows(analyses: AnalysisSummary[]): DashboardRow[] {
  const rows: DashboardRow[] = [];
  const byJob = new Map<string, Extract<DashboardRow, { kind: "batch" }>>();
  for (const analysis of analyses) {
    const parent = analysis.ingestionJob;
    if (analysis.ingestionJobId && parent?.mode === "SITE_SEARCH") {
      const existing = byJob.get(analysis.ingestionJobId);
      if (existing) {
        existing.analyses.push(analysis);
        continue;
      }
      const row = {
        kind: "batch" as const,
        ingestionJobId: analysis.ingestionJobId,
        siteConfigId: parent.siteConfigId,
        analyses: [analysis],
      };
      byJob.set(analysis.ingestionJobId, row);
      rows.push(row);
    } else {
      rows.push({ kind: "single", analysis });
    }
  }
  return rows;
}

function bestScore(analyses: AnalysisSummary[]): number | null {
  const scores = analyses
    .map((a) => a.matchScore)
    .filter((s): s is number => s !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}

function rowScore(row: DashboardRow): number | null {
  return row.kind === "batch"
    ? bestScore(row.analyses)
    : row.analysis.matchScore;
}

/**
 * Order the grouped rows for display. `"recent"` keeps the API's recency
 * ordering (a batch sits in its first-seen slot); `"score"` sorts by match
 * score descending, rows with no score last. The sort is stable, so equal rows
 * keep their recency order.
 */
function sortRows(rows: DashboardRow[], sort: AnalysesFilterState["sort"]) {
  if (sort !== "score") return rows;
  return [...rows].sort((a, b) => {
    const sa = rowScore(a);
    const sb = rowScore(b);
    if (sa === sb) return 0;
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  });
}

export default function AnalysesDashboardPage() {
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");
  const { data: analyses, isPending, isError } = useAnalyses();
  const { data: siteConfigs } = useSiteConfigs();

  const [filters, setFilters] = useState<AnalysesFilterState>(
    DEFAULT_ANALYSES_FILTERS,
  );

  const cvLabels = useMemo(
    () => (analyses ? cvLabelsOf(analyses) : []),
    [analyses],
  );
  const rows = useMemo(
    () =>
      analyses
        ? sortRows(groupRows(filterAnalyses(analyses, filters)), filters.sort)
        : [],
    [analyses, filters],
  );

  const hasAnalyses = Boolean(analyses && analyses.length > 0);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>

      {isPending && (
        <div
          role="status"
          aria-label={t("loading")}
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
            <Label htmlFor="analyses-search">{t("controls.searchLabel")}</Label>
            <Input
              id="analyses-search"
              type="search"
              placeholder={t("controls.searchPlaceholder")}
              value={filters.search}
              onChange={(event) =>
                setFilters((f) => ({ ...f, search: event.target.value }))
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-status">{t("controls.statusLabel")}</Label>
            <select
              id="analyses-status"
              className={SELECT_CLASS}
              value={filters.status}
              onChange={(event) =>
                setFilters((f) => ({
                  ...f,
                  status: event.target.value as AnalysesFilterState["status"],
                }))
              }
            >
              <option value="all">{t("controls.statusAll")}</option>
              {ANALYSIS_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analyses-cv">{t("controls.cvLabel")}</Label>
            <select
              id="analyses-cv"
              className={SELECT_CLASS}
              value={filters.cvLabel}
              onChange={(event) =>
                setFilters((f) => ({ ...f, cvLabel: event.target.value }))
              }
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
            <Label htmlFor="analyses-sort">{t("controls.sortLabel")}</Label>
            <select
              id="analyses-sort"
              className={SELECT_CLASS}
              value={filters.sort}
              onChange={(event) =>
                setFilters((f) => ({
                  ...f,
                  sort: event.target.value as AnalysesFilterState["sort"],
                }))
              }
            >
              <option value="recent">{t("controls.sortRecent")}</option>
              <option value="score">{t("controls.sortScore")}</option>
            </select>
          </div>
        </div>
      )}

      {hasAnalyses && rows.length === 0 && (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {rows.map((row) =>
            row.kind === "batch" ? (
              <li key={`batch-${row.ingestionJobId}`}>
                <Link href={`/analyses/batch/${row.ingestionJobId}`}>
                  <Card className="py-0 transition-colors hover:bg-panel">
                    <CardContent className="flex items-center justify-between gap-4 py-4">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {siteConfigs?.find((s) => s.id === row.siteConfigId)
                            ?.displayName ?? t("batch.siteFallback")}
                        </span>
                        <span className="text-sm text-muted">
                          {t("batch.offers", { count: row.analyses.length })}
                        </span>
                      </div>
                      {bestScore(row.analyses) !== null && (
                        <div className="flex shrink-0 flex-col items-end">
                          <span className="text-lg font-semibold tabular-nums">
                            {bestScore(row.analyses)}
                          </span>
                          <span className="text-xs text-muted">
                            {t("batch.bestScore")}
                          </span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ) : (
              <li key={row.analysis.id} className="flex flex-col gap-1">
                <AnalysisRow analysis={row.analysis} />
                <Link
                  href={`/analyses/compare/${row.analysis.jobOffer.id}`}
                  className="text-xs text-accent hover:underline"
                >
                  {t("compareLink")}
                </Link>
              </li>
            ),
          )}
        </ul>
      )}
    </main>
  );
}
