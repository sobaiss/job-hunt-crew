"use client";

import { useTranslations } from "next-intl";

import { useScoutRuns, type ScoutRun, type ScoutRunStatus } from "@/hooks/use-scouts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function runStatusVariant(
  status: ScoutRunStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "PARTIALLY_COMPLETED") return "warning";
  if (status === "FAILED") return "destructive";
  return "secondary";
}

/**
 * A Scout's run history — extracted from the former `/scouts/[id]` detail
 * page so the Scout panel can absorb it (issue #92, superseding
 * docs/adr/0006 — see docs/adr/0007-scout-panel-full-absorption.md).
 */
export function ScoutRunHistory({ scoutId }: { scoutId: string }) {
  const t = useTranslations("scouts.runs");
  const { data: runs, isPending } = useScoutRuns(scoutId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-6 text-sm">
        <h2 className="font-serif text-lg font-semibold">{t("heading")}</h2>
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !runs || runs.length === 0 ? (
          <p className="text-muted">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {runs.map((run: ScoutRun) => (
              <li
                key={run.id}
                className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <Badge variant={runStatusVariant(run.status)}>
                    {t(`status.${run.status}`)}
                  </Badge>
                  <span className="text-muted">
                    {t("started", {
                      date: new Date(run.createdAt).toLocaleString(),
                    })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
                  <span>{t("sitesQueried", { count: run.sitesQueried })}</span>
                  {run.siteUnavailableCount > 0 && (
                    <span>
                      {t("siteUnavailable", { count: run.siteUnavailableCount })}
                    </span>
                  )}
                  <span>
                    {t("offersDiscovered", { count: run.offersDiscovered })}
                  </span>
                  <span>
                    {t("offersAnalysed", { count: run.offersAnalysed })}
                  </span>
                  {run.alreadySeenCount > 0 && (
                    <span>{t("alreadySeen", { count: run.alreadySeenCount })}</span>
                  )}
                  {run.runLimitSkippedCount > 0 && (
                    <span>
                      {t("runLimitSkipped", { count: run.runLimitSkippedCount })}
                    </span>
                  )}
                  {run.capSkippedCount > 0 && (
                    <span>{t("capSkipped", { count: run.capSkippedCount })}</span>
                  )}
                </div>
                {run.errorMessage && (
                  <p className="text-destructive">{run.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
