"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { LucideIcon } from "lucide-react";

import type { ApplicationStats, ApplicationStatsWindow } from "@/hooks/use-applications";
import { cn } from "@/lib/utils";
import { PanelSection } from "@/components/panel-section";
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

/** The all-time / last-30-days switch, as a segmented control: two text
 *  buttons separated by a "·" read as prose, not as a choice. */
function WindowToggle({
  value,
  onChange,
  labels,
}: {
  value: "allTime" | "last30Days";
  onChange: (next: "allTime" | "last30Days") => void;
  labels: Record<"allTime" | "last30Days", string>;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-panel p-0.5">
      {(["allTime", "last30Days"] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          className={cn(
            "rounded-[5px] px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === key
              ? "bg-background font-medium text-foreground shadow-xs"
              : "text-muted hover:text-foreground",
          )}
          onClick={() => onChange(key)}
        >
          {labels[key]}
        </button>
      ))}
    </div>
  );
}

/**
 * The stats header shared by the Applications view (global) and the Scout
 * panel (scoped) — issue #60. Zero-safe: renders the same grid with every
 * metric at 0 / "—" rather than hiding when there's no data yet.
 *
 * `title`/`icon` are for a surface that stacks this with other titled
 * sections (the Scout panel); the Applications view passes neither and gets
 * the same card with only the window toggle in its header bar.
 */
export function ApplicationStatsHeader({
  stats,
  isPending,
  isError,
  title,
  icon,
}: {
  stats: ApplicationStats | undefined;
  isPending: boolean;
  isError: boolean;
  title?: string;
  icon?: LucideIcon;
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
    <PanelSection
      icon={icon}
      title={title}
      trailing={
        <WindowToggle
          value={windowKey}
          onChange={setWindowKey}
          labels={{
            allTime: t("windows.allTime"),
            last30Days: t("windows.last30Days"),
          }}
        />
      }
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {METRIC_KEYS.map((key) => (
          <div
            key={key}
            className="flex flex-col gap-1 rounded-lg bg-panel px-3 py-2.5"
          >
            <dt className="text-xs text-muted">{t(`metrics.${key}`)}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatMetric(key, window)}
            </dd>
          </div>
        ))}
      </dl>
    </PanelSection>
  );
}
