"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  useIngestionJob,
  TERMINAL_INGESTION_STATUSES,
} from "@/hooks/use-ingestion-jobs";
import {
  useAnalyses,
  TERMINAL_ANALYSIS_STATUSES,
  type AnalysisDetail,
  type AnalysisStatus,
} from "@/hooks/use-analyses";
import { useEnumLabel } from "@/lib/enum-labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

function badgeVariant(
  status: AnalysisStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING" || status === "QUEUED") return "secondary";
  return "warning";
}

/** Best Match score first; an Analysis with no score yet sorts last. */
function byScoreDesc(a: AnalysisDetail, b: AnalysisDetail): number {
  return (b.matchScore ?? -1) - (a.matchScore ?? -1);
}

/**
 * The Batch result view: a two-phase progress header (offers discovered, then
 * analyses completed) above the batch's Analyses ranked by Match score, each
 * row linking to its Analysis detail. Polls the IngestionJob and its Analysis
 * batch, stopping once the job is terminal and every Analysis in it is too. A
 * run that found nothing, or where every fetch failed, shows a clear message
 * instead of a silently empty list; a discreet link drops to the raw
 * scraping-progress page.
 *
 * Rendered both inline on "Analyse several offers" right after submit and, via
 * `app/(app)/analyses/batch/[id]`, as a routable page the Dashboard's grouped
 * SITE_SEARCH row links to (#34) and that survives closing the tab (#36).
 */
export function BatchResultView({ ingestionJobId }: { ingestionJobId: string }) {
  const t = useTranslations("analyseSeveral");
  const statusLabel = useEnumLabel("analysisStatus");

  const job = useIngestionJob(ingestionJobId);
  const jobTerminal =
    job.data != null && TERMINAL_INGESTION_STATUSES.has(job.data.status);

  const analysesQuery = useAnalyses({
    ingestionJobId,
    batchRunning: !jobTerminal,
  });

  const analyses = useMemo(
    () => [...(analysesQuery.data ?? [])].sort(byScoreDesc),
    [analysesQuery.data],
  );

  const discovered = job.data?.discoveredCount ?? 0;
  const completed = analyses.filter((a) =>
    TERMINAL_ANALYSIS_STATUSES.has(a.status),
  ).length;

  // Offers the fan-out left unanalysed because the owner hit their daily cap.
  // The IngestionJob only records how many (`quotaSkippedCount`); pair that
  // count with the trailing READY offers that have no Analysis so each row can
  // name its offer, falling back to a bare marker when the job detail lags.
  const quotaSkippedCount = job.data?.quotaSkippedCount ?? 0;
  const quotaSkippedRows = useMemo(() => {
    if (quotaSkippedCount === 0) return [];
    const analysedOfferIds = new Set(analyses.map((a) => a.jobOffer.id));
    const unanalysed = (job.data?.jobOffers ?? [])
      .map((entry) => entry.jobOffer)
      .filter(
        (offer) =>
          offer.extractionStatus === "READY" &&
          !analysedOfferIds.has(offer.id),
      );
    return Array.from({ length: quotaSkippedCount }, (_, i) => ({
      key: unanalysed[i]?.id ?? `quota-skipped-${i}`,
      title: unanalysed[i]?.title ?? null,
      company: unanalysed[i]?.company ?? null,
    }));
  }, [quotaSkippedCount, analyses, job.data?.jobOffers]);

  const emptyRun =
    jobTerminal && analyses.length === 0 && quotaSkippedRows.length === 0
      ? job.data?.status === "FAILED" || (job.data?.failedCount ?? 0) > 0
        ? "allFailed"
        : "empty"
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div role="status" className="flex flex-col gap-2">
        <h2 className="font-serif text-xl font-semibold">
          {t("progressHeading")}
        </h2>
        <dl className="flex gap-6 text-sm">
          <div className="flex flex-col">
            <dt className="text-muted">{t("discovered")}</dt>
            <dd className="text-lg font-semibold tabular-nums">{discovered}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted">{t("analysesDone")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {completed} / {analyses.length}
            </dd>
          </div>
        </dl>
      </div>

      {emptyRun && (
        <p role="alert" className="text-sm text-muted">
          {t(emptyRun)}
        </p>
      )}

      {analyses.length > 0 && (
        <ul className="flex flex-col gap-3">
          {analyses.map((analysis) => (
            <li key={analysis.id}>
              <Card className="py-0 transition-colors hover:bg-panel">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <Link
                    href={`/analyses/${analysis.id}`}
                    className="flex min-w-0 flex-col"
                  >
                    <span className="truncate font-medium">
                      {analysis.jobOffer.title ?? t("jobOfferFallback")}
                    </span>
                    {analysis.jobOffer.company && (
                      <span className="truncate text-sm text-muted">
                        {analysis.jobOffer.company}
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {t("vsCv", { label: analysis.cvVersion.label })}
                    </span>
                  </Link>
                  <div className="flex shrink-0 items-center gap-3">
                    {analysis.matchScore !== null && (
                      <span className="text-lg font-semibold tabular-nums">
                        {analysis.matchScore}
                      </span>
                    )}
                    <Badge variant={badgeVariant(analysis.status)}>
                      {statusLabel(analysis.status)}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {quotaSkippedRows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {quotaSkippedRows.map((row) => (
            <li key={row.key}>
              <Card className="py-0">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {row.title ?? t("jobOfferFallback")}
                    </span>
                    {row.company && (
                      <span className="truncate text-sm text-muted">
                        {row.company}
                      </span>
                    )}
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {t("quotaSkipped")}
                  </Badge>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/ingestion-jobs/${ingestionJobId}`}
        className="text-xs text-accent hover:underline"
      >
        {t("scrapingDetail")}
      </Link>
    </div>
  );
}
