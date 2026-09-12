"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { useScouts, type ScoutStatus } from "@/hooks/use-scouts";
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

export default function ScoutsPage() {
  const t = useTranslations("scouts");
  const { data: scouts, isPending, isError } = useScouts();
  const { data: cvVersions } = useCvVersions();

  const cvLabel = (id: string) =>
    cvVersions?.find((cv) => cv.id === id)?.label ?? id;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("list.subtitle")}</p>
        </div>
        <Button asChild className="shrink-0">
          <Link href="/scouts/new">{t("list.new")}</Link>
        </Button>
      </div>

      {isPending && (
        <div
          role="status"
          aria-label={t("list.loading")}
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("list.loadError")}
        </p>
      )}

      {scouts && scouts.length === 0 && (
        <p className="text-sm text-muted">{t("list.empty")}</p>
      )}

      {scouts && scouts.length > 0 && (
        <ul className="flex flex-col gap-3">
          {scouts.map((scout) => (
            <li key={scout.id}>
              <Card className="py-0">
                <CardContent className="flex flex-col gap-2 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <Link
                      href={`/scouts/${scout.id}`}
                      className="truncate font-medium text-accent underline-offset-2 hover:underline"
                    >
                      {scout.label}
                    </Link>
                    <Badge variant={statusVariant(scout.status)}>
                      {t(`status.${scout.status}`)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    <span>
                      {t("list.baseCv")}: {cvLabel(scout.cvVersionId)}
                    </span>
                    <span>
                      {t("list.sites", { count: scout.targetSiteKeys.length })}
                    </span>
                    <span>
                      {t("list.lastRun")}:{" "}
                      {scout.lastRunAt
                        ? new Date(scout.lastRunAt).toLocaleDateString()
                        : t("list.neverRun")}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
