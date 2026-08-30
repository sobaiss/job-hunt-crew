"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useIngestionJob,
  type IngestionJobStatus,
} from "@/hooks/use-ingestion-jobs";
import { useEnumLabel } from "@/lib/enum-labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function badgeVariant(
  status: IngestionJobStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING") return "secondary";
  return "warning";
}

export default function IngestionJobPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("ingestion");
  const statusLabel = useEnumLabel("ingestionStatus");
  const { data: job, isPending, isError } = useIngestionJob(params.id);

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <div
          role="status"
          aria-label={t("detail.loading")}
          className="flex flex-col gap-4"
        >
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </main>
    );
  }

  if (isError || !job) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("detail.loadError")}
        </p>
      </main>
    );
  }

  const stats: { key: "discovered" | "scraped" | "failedCount"; value: number }[] =
    [
      { key: "discovered", value: job.discoveredCount },
      { key: "scraped", value: job.scrapedCount },
      { key: "failedCount", value: job.failedCount },
    ];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl font-semibold">
          {t("detail.heading")}
        </h1>
        <Badge variant={badgeVariant(job.status)} className="self-start">
          {statusLabel(job.status)}
        </Badge>
      </div>

      {job.status === "PENDING" && (
        <p role="status" className="text-sm text-muted">
          {t("detail.waiting")}
        </p>
      )}

      {job.status === "RUNNING" && (
        <p className="text-sm text-muted">{t("detail.running")}</p>
      )}

      {job.status === "FAILED" && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p>{t("detail.failed")}</p>
          {job.errorMessage && <p>{job.errorMessage}</p>}
        </div>
      )}

      <dl className="grid grid-cols-3 gap-3">
        {stats.map(({ key, value }) => (
          <Card key={key} className="py-0">
            <CardContent className="flex flex-col gap-1 py-4">
              <dt className="text-xs text-muted">{t(`detail.${key}`)}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
            </CardContent>
          </Card>
        ))}
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="font-serif text-xl font-semibold">
          {t("detail.offersHeading")}
        </h2>
        {job.jobOffers.length === 0 ? (
          <p className="text-sm text-muted">{t("detail.offersEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {job.jobOffers.map(({ jobOffer }) => (
              <li key={jobOffer.id}>
                <Card className="py-0">
                  <CardContent className="flex items-center justify-between gap-4 py-3">
                    <span className="truncate text-sm">
                      {jobOffer.title ?? jobOffer.id}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {jobOffer.extractionStatus}
                    </span>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
