"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  useAnalyses,
  type AnalysisSummary,
} from "@/hooks/use-analyses";
import { useSiteConfigs } from "@/hooks/use-site-configs";
import { AnalysisRow } from "@/components/analysis-row";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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

export default function AnalysesDashboardPage() {
  const t = useTranslations("analyses");
  const { data: analyses, isPending, isError } = useAnalyses();
  const { data: siteConfigs } = useSiteConfigs();

  const rows = analyses ? groupRows(analyses) : [];

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
