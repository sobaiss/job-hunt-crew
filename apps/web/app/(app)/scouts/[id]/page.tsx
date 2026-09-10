"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useScout,
  useUpdateScout,
  type ScoutStatus,
} from "@/hooks/use-scouts";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function statusVariant(
  status: ScoutStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PAUSED") return "warning";
  return "secondary";
}

export default function ScoutDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("scouts");
  const tSites = useTranslations("scouts.siteKeys");

  const { data: scout, isPending, isError } = useScout(params.id);
  const { data: cvVersions } = useCvVersions();
  const update = useUpdateScout(params.id);

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <div
          role="status"
          aria-label={t("detail.loading")}
          className="flex flex-col gap-4"
        >
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </main>
    );
  }

  if (isError || !scout) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("detail.loadError")}
        </p>
        <Link href="/scouts" className="mt-4 inline-block text-sm text-accent underline">
          {t("detail.back")}
        </Link>
      </main>
    );
  }

  const cvLabel =
    cvVersions?.find((cv) => cv.id === scout.cvVersionId)?.label ??
    scout.cvVersionId;
  const activeFilters = Object.entries(scout.filters).filter(
    ([, value]) => value != null && value !== "",
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-serif text-2xl font-semibold">{scout.label}</h1>
          <Badge variant={statusVariant(scout.status)}>
            {t(`status.${scout.status}`)}
          </Badge>
        </div>
        {scout.status !== "ARCHIVED" && (
          <Button asChild variant="outline" className="shrink-0">
            <Link href={`/scouts/${scout.id}/edit`}>{t("actions.edit")}</Link>
          </Button>
        )}
      </div>

      {scout.status !== "ARCHIVED" && (
        <div className="flex flex-wrap gap-2">
          {scout.status === "ACTIVE" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: "PAUSED" })}
            >
              {t("actions.pause")}
            </Button>
          )}
          {scout.status === "PAUSED" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: "ACTIVE" })}
            >
              {t("actions.resume")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: "ARCHIVED" })}
          >
            {t("actions.archive")}
          </Button>
        </div>
      )}

      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("actions.updateError")}
        </p>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3 py-6 text-sm">
          <h2 className="font-serif text-lg font-semibold">
            {t("detail.configHeading")}
          </h2>
          <div className="flex justify-between gap-4">
            <span className="text-muted">{t("detail.baseCv")}</span>
            <span>{cvLabel}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">{t("detail.sites")}</span>
            <span className="text-right">
              {scout.targetSiteKeys.map((key) => tSites(key)).join(", ")}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">{t("detail.threshold")}</span>
            <span>{scout.matchThreshold}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">{t("detail.filters")}</span>
            <span className="text-right">
              {activeFilters.length > 0
                ? activeFilters.map(([k, v]) => `${k}: ${v}`).join(", ")
                : t("detail.noFilters")}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">{t("detail.lastRun")}</span>
            <span>
              {scout.lastRunAt
                ? new Date(scout.lastRunAt).toLocaleString()
                : t("detail.neverRun")}
            </span>
          </div>
        </CardContent>
      </Card>

      <Link href="/scouts" className="text-sm text-accent underline">
        {t("detail.back")}
      </Link>
    </main>
  );
}
