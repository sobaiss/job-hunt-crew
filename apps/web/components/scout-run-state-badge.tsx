"use client";

import { useTranslations } from "next-intl";

import type { ScoutRunState } from "@/hooks/use-scouts";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// A Scout's Run state as the Scouts table's Execution column shows it
// (#226), built to be reused unchanged by the Scout panel's header (#227):
// the rule lives once on the server (docs/adr/0033), and the rendering lives
// once here. The state is read straight off `runState` and never re-derived
// from timestamps; only the duration is computed, from `runStateSince`.
// Colours follow the run history's own badges (scout-run-history.tsx).

const BADGE_VARIANT: Record<
  Exclude<ScoutRunState, "OK" | "NEVER_RUN">,
  "secondary" | "destructive" | "warning"
> = {
  IN_FLIGHT: "secondary",
  BLOCKED: "destructive",
  FAILED: "destructive",
  DEGRADED: "warning",
};

/**
 * Whole minutes elapsed since `since`, judged against `now` — the caller
 * passes the moment the data was fetched, so the duration is recomputed on
 * each fetch and never ticks on its own (the work lasts minutes; scrolling
 * seconds would be agitation, not information).
 */
function elapsedMinutes(since: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
}

export function ScoutRunStateBadge({
  runState,
  runStateSince,
  now,
}: {
  runState: ScoutRunState;
  runStateSince: string | null;
  now: number;
}) {
  const t = useTranslations("scouts.runState");

  // "Jamais exécuté" is already the neighbouring Last-run column's answer;
  // two adjacent columns should not say the same thing twice.
  if (runState === "NEVER_RUN") return <span className="text-muted">—</span>;

  // Calm on purpose, so the coloured badges keep meaning something.
  if (runState === "OK") {
    return <span className="text-sm text-muted">{t("label.OK")}</span>;
  }

  let duration: string | null = null;
  if (runStateSince) {
    const minutes = elapsedMinutes(runStateSince, now);
    duration =
      minutes < 1
        ? t("duration.lessThanMinute")
        : minutes < 60
          ? t("duration.minutes", { minutes })
          : t("duration.hours", {
              hours: Math.floor(minutes / 60),
              minutes: minutes % 60,
            });
  }

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Badge variant={BADGE_VARIANT[runState]}>
              {t(`label.${runState}`)}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t(`explanation.${runState}`)}</TooltipContent>
      </Tooltip>
      {duration && (
        <span className="text-xs whitespace-nowrap text-muted tabular-nums">
          {duration}
        </span>
      )}
    </span>
  );
}
