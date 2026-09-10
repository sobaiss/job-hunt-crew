"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import type { AnalysisStatus, AnalysisSummary } from "@/hooks/use-analyses";
import { useEnumLabel } from "@/lib/enum-labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export function analysisBadgeVariant(
  status: AnalysisStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING" || status === "QUEUED") return "secondary";
  return "warning";
}

/**
 * One standalone Analysis as a card row: the offer title + company, which CV it
 * ran against, the match score, and a status badge, linking to the detail page.
 * Factored out of the Analyses list so the Dashboard's recent-analyses list
 * (spec #43) and, later, the list controls (#44) render the same row.
 */
export function AnalysisRow({ analysis }: { analysis: AnalysisSummary }) {
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");

  return (
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
          <Badge variant={analysisBadgeVariant(analysis.status)}>
            {statusLabel(analysis.status)}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
