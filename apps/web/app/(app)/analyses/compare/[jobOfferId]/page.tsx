"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { useAnalyses } from "@/hooks/use-analyses";
import { compareColumns } from "@/lib/compare-columns";
import { AnalysisCompareTable } from "@/components/analysis-compare-table";
import { Skeleton } from "@/components/ui/skeleton";

export default function CompareAnalysesPage() {
  const params = useParams<{ jobOfferId: string }>();
  const t = useTranslations("analyses");
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
  const columns = compareColumns(analyses);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">
          {offer.title ?? t("jobOfferFallback")}
        </h1>
        {offer.company && <p className="text-sm text-muted">{offer.company}</p>}
        <p className="text-sm text-muted">
          {t("compare.count", { count: columns.length })}
        </p>
      </div>

      {columns.length < 2 && (
        <p className="text-sm text-warning">{t("compare.singleNotice")}</p>
      )}

      <AnalysisCompareTable columns={columns} />
    </main>
  );
}
