"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { useAnalyses, type AnalysisStatus } from "@/hooks/use-analyses";
import { useEnumLabel } from "@/lib/enum-labels";
import { AnalysisResultView } from "@/components/analysis-result";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function badgeVariant(
  status: AnalysisStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING" || status === "QUEUED") return "secondary";
  return "warning";
}

export default function CompareAnalysesPage() {
  const params = useParams<{ jobOfferId: string }>();
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");
  const {
    data: analyses,
    isPending,
    isError,
  } = useAnalyses({ jobOfferId: params.jobOfferId });

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-6xl p-8">
        <div
          role="status"
          aria-label={t("compare.loading")}
          className="flex gap-6"
        >
          <Skeleton className="h-96 w-80" />
          <Skeleton className="h-96 w-80" />
        </div>
      </main>
    );
  }

  if (isError || !analyses) {
    return (
      <main className="mx-auto w-full max-w-6xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("compare.loadError")}
        </p>
      </main>
    );
  }

  if (analyses.length === 0) {
    return (
      <main className="mx-auto w-full max-w-6xl p-8">
        <p className="text-sm text-muted">{t("compare.empty")}</p>
      </main>
    );
  }

  const offer = analyses[0].jobOffer;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">
          {offer.title ?? t("jobOfferFallback")}
        </h1>
        {offer.company && (
          <p className="text-sm text-muted">{offer.company}</p>
        )}
        <p className="text-sm text-muted">
          {t("compare.count", { count: analyses.length })}
        </p>
      </div>

      {analyses.length < 2 && (
        <p className="text-sm text-warning">{t("compare.singleNotice")}</p>
      )}

      <div className="flex gap-6 overflow-x-auto pb-2">
        {analyses.map((analysis) => (
          <Card
            key={analysis.id}
            className="w-80 shrink-0 gap-6 p-6"
          >
            <div className="flex flex-col gap-2">
              <h2 className="font-serif text-lg font-semibold">
                {analysis.cvVersion.label}
              </h2>
              <Badge
                variant={badgeVariant(analysis.status)}
                className="self-start"
              >
                {statusLabel(analysis.status)}
              </Badge>
            </div>

            {analysis.resultJSON ? (
              <AnalysisResultView result={analysis.resultJSON} />
            ) : (
              <p className="text-sm text-muted">{t("compare.noResult")}</p>
            )}
          </Card>
        ))}
      </div>
    </main>
  );
}
