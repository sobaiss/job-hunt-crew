"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  useAnalyses,
  type AnalysisStatus,
} from "@/hooks/use-analyses";
import { useEnumLabel } from "@/lib/enum-labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function badgeVariant(
  status: AnalysisStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING" || status === "QUEUED") return "secondary";
  return "warning";
}

export default function AnalysesDashboardPage() {
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");
  const { data: analyses, isPending, isError } = useAnalyses();

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

      {analyses && analyses.length > 0 && (
        <ul className="flex flex-col gap-3">
          {analyses.map((analysis) => (
            <li key={analysis.id} className="flex flex-col gap-1">
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
              <Link
                href={`/analyses/compare/${analysis.jobOffer.id}`}
                className="text-xs text-accent hover:underline"
              >
                {t("compareLink")}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
