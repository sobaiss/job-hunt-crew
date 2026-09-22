"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Clock } from "lucide-react";

import { useScoutRuns, type ScoutRun, type ScoutRunStatus } from "@/hooks/use-scouts";
import { cn } from "@/lib/utils";
import { PanelEmptyState, PanelSection } from "@/components/panel-section";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

function runStatusVariant(
  status: ScoutRunStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "PARTIALLY_COMPLETED") return "warning";
  if (status === "FAILED") return "destructive";
  return "secondary";
}

/** The timeline dot, in the same status colour as the run's badge. */
function runDotClass(status: ScoutRunStatus): string {
  if (status === "COMPLETED") return "bg-success";
  if (status === "PARTIALLY_COMPLETED") return "bg-warning";
  if (status === "FAILED") return "bg-danger";
  return "bg-muted";
}

/** One run counter. Reads as a chip rather than a run-on sentence, so a run
 *  with six of them still scans. */
function RunStat({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-panel px-2 py-0.5 text-xs text-muted tabular-nums">
      {children}
    </span>
  );
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
    <PanelSection
      icon={Clock}
      title={t("heading")}
      trailing={
        runs && runs.length > 0 ? (
          <Badge variant="muted" className="tabular-nums">
            {runs.length}
          </Badge>
        ) : null
      }
    >
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : !runs || runs.length === 0 ? (
        <PanelEmptyState icon={Clock}>{t("empty")}</PanelEmptyState>
      ) : (
        <ol className="flex flex-col">
          {runs.map((run: ScoutRun) => (
            <li
              key={run.id}
              className="relative flex flex-col gap-2 border-l border-border pb-5 pl-5 last:border-transparent last:pb-0"
            >
              <span
                className={cn(
                  "absolute top-1.5 -left-1 size-2 rounded-full",
                  runDotClass(run.status),
                )}
                aria-hidden
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant={runStatusVariant(run.status)}>
                  {t(`status.${run.status}`)}
                </Badge>
                <span className="text-xs text-muted">
                  {t("started", {
                    date: new Date(run.createdAt).toLocaleString(),
                  })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <RunStat>{t("sitesQueried", { count: run.sitesQueried })}</RunStat>
                {run.siteUnavailableCount > 0 && (
                  <RunStat>
                    {t("siteUnavailable", { count: run.siteUnavailableCount })}
                  </RunStat>
                )}
                <RunStat>
                  {t("offersDiscovered", { count: run.offersDiscovered })}
                </RunStat>
                <RunStat>
                  {t("offersAnalysed", { count: run.offersAnalysed })}
                </RunStat>
                {run.alreadySeenCount > 0 && (
                  <RunStat>
                    {t("alreadySeen", { count: run.alreadySeenCount })}
                  </RunStat>
                )}
                {run.runLimitSkippedCount > 0 && (
                  <RunStat>
                    {t("runLimitSkipped", { count: run.runLimitSkippedCount })}
                  </RunStat>
                )}
                {run.capSkippedCount > 0 && (
                  <RunStat>
                    {t("capSkipped", { count: run.capSkippedCount })}
                  </RunStat>
                )}
              </div>
              {run.errorMessage && (
                <p className="text-xs text-destructive">{run.errorMessage}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </PanelSection>
  );
}
