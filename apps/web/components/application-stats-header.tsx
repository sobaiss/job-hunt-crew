"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import type { ApplicationStats, ApplicationStatsWindow } from "@/hooks/use-applications";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const METRIC_KEYS = [
  "offersDiscovered",
  "relevantFinds",
  "documentsGenerated",
  "applicationsSubmitted",
  "responseRate",
  "interviewRate",
  "offerRate",
  "acceptanceRate",
  "medianDaysToFirstResponse",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

const RATE_METRICS = new Set<MetricKey>([
  "responseRate",
  "interviewRate",
  "offerRate",
  "acceptanceRate",
]);

function formatMetric(key: MetricKey, window: ApplicationStatsWindow): string {
  if (key === "medianDaysToFirstResponse") {
    return window.medianDaysToFirstResponse === null
      ? "—"
      : String(window.medianDaysToFirstResponse);
  }
  const value = window[key];
  return RATE_METRICS.has(key) ? `${value}%` : String(value);
}

/**
 * The stats header shared by the Applications view (global) and a Scout's
 * detail page (scoped) — issue #60. Zero-safe: renders the same grid with
 * every metric at 0 / "—" rather than hiding when there's no data yet.
 */
export function ApplicationStatsHeader({
  stats,
  isPending,
  isError,
}: {
  stats: ApplicationStats | undefined;
  isPending: boolean;
  isError: boolean;
}) {
  const t = useTranslations("stats");
  const [windowKey, setWindowKey] = useState<"allTime" | "last30Days">("allTime");

  if (isPending) {
    return <Skeleton className="h-32 w-full" />;
  }

  if (isError || !stats) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  const window = stats[windowKey];

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-6">
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            className={
              windowKey === "allTime"
                ? "font-semibold text-foreground underline"
                : "text-muted hover:text-foreground"
            }
            onClick={() => setWindowKey("allTime")}
          >
            {t("windows.allTime")}
          </button>
          <span className="text-muted">·</span>
          <button
            type="button"
            className={
              windowKey === "last30Days"
                ? "font-semibold text-foreground underline"
                : "text-muted hover:text-foreground"
            }
            onClick={() => setWindowKey("last30Days")}
          >
            {t("windows.last30Days")}
          </button>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {METRIC_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <dt className="text-xs text-muted">{t(`metrics.${key}`)}</dt>
              <dd className="text-lg font-semibold">{formatMetric(key, window)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
