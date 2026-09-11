"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useAnalyses } from "@/hooks/use-analyses";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { useScouts } from "@/hooks/use-scouts";
import {
  computeStats,
  newMatchesCount,
  onboardingSteps,
  scoreTrend,
  type OnboardingSteps,
} from "@/lib/dashboard-metrics";
import { cn } from "@/lib/utils";
import { AnalysisRow } from "@/components/analysis-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** How many recent analyses the Dashboard shows. */
const RECENT_LIMIT = 5;

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-5">
        <span className="text-sm text-muted">{label}</span>
        <span className="text-3xl font-semibold tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
}

function OnboardingChecklist({ steps }: { steps: OnboardingSteps }) {
  const t = useTranslations("dashboard.onboarding");
  const items: { done: boolean; label: string; hint: string }[] = [
    { done: steps.hasCv, label: t("importCv"), hint: t("importCvHint") },
    { done: steps.hasAnalysis, label: t("runAnalysis"), hint: t("runAnalysisHint") },
    { done: steps.hasComparison, label: t("compare"), hint: t("compareHint") },
  ];

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-6">
        <h2 className="font-serif text-lg font-semibold">{t("heading")}</h2>
        <ol className="flex flex-col gap-3">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-5 flex-none items-center justify-center rounded-full border text-xs",
                  item.done
                    ? "border-success bg-success text-white"
                    : "border-border text-muted",
                )}
              >
                {item.done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="flex flex-col">
                <span
                  className={cn(
                    "text-sm font-medium",
                    item.done && "text-muted line-through",
                  )}
                >
                  {item.label}
                </span>
                <span className="text-xs text-muted">{item.hint}</span>
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/**
 * The signed-in `/` Dashboard: an at-a-glance overview computed entirely
 * client-side from the `/api/analyses` list and the `/api/cv-versions` count
 * (spec #43) — stat tiles, a Match score trend, recent analyses and quick
 * actions. While the Candidate has no Analysis yet, a data-derived onboarding
 * checklist replaces the stat tiles.
 */
export function Dashboard() {
  const t = useTranslations("dashboard");
  const analysesQuery = useAnalyses();
  const cvVersionsQuery = useCvVersions();
  const scoutsQuery = useScouts();

  if (analysesQuery.isPending || cvVersionsQuery.isPending) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <div
          role="status"
          aria-label={t("loading")}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </main>
    );
  }

  if (analysesQuery.isError || cvVersionsQuery.isError) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      </main>
    );
  }

  const analyses = analysesQuery.data ?? [];
  const cvVersionCount = cvVersionsQuery.data?.length ?? 0;
  const stats = computeStats(analyses, cvVersionCount);
  const steps = onboardingSteps(analyses, cvVersionCount);
  const trend = scoreTrend(analyses);
  // The `/api/analyses` list is already recency-ordered.
  const recent = analyses.slice(0, RECENT_LIMIT);
  const showOnboarding = analyses.length === 0;
  const newMatches = newMatchesCount(scoutsQuery.data ?? []);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>

      {newMatches > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
            <div className="flex flex-col gap-1">
              <h2 className="font-serif text-lg font-semibold">
                {t("matches.heading", { count: newMatches })}
              </h2>
              <p className="text-sm text-muted">{t("matches.subtitle")}</p>
            </div>
            <Button asChild>
              <Link href="/scouts">{t("matches.cta")}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {showOnboarding ? (
        <OnboardingChecklist steps={steps} />
      ) : (
        <section
          aria-labelledby="dashboard-stats"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <h2 id="dashboard-stats" className="sr-only">
            {t("stats.heading")}
          </h2>
          <StatTile
            label={t("stats.averageScore")}
            value={stats.averageScore ?? "—"}
          />
          <StatTile
            label={t("stats.bestScore")}
            value={stats.bestScore ?? "—"}
          />
          <StatTile
            label={t("stats.analysisCount")}
            value={stats.analysisCount}
          />
          <StatTile
            label={t("stats.cvVersionCount")}
            value={stats.cvVersionCount}
          />
        </section>
      )}

      <section aria-labelledby="dashboard-actions" className="flex flex-col gap-3">
        <h2
          id="dashboard-actions"
          className="font-serif text-lg font-semibold"
        >
          {t("quickActions.heading")}
        </h2>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/analyses/new">{t("quickActions.analyseOne")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/analyses/new/several">
              {t("quickActions.analyseSeveral")}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/cv-versions">{t("quickActions.importCv")}</Link>
          </Button>
        </div>
      </section>

      {trend.length >= 2 && (
        <section
          aria-labelledby="dashboard-trend"
          className="flex flex-col gap-3"
        >
          <h2
            id="dashboard-trend"
            className="font-serif text-lg font-semibold"
          >
            {t("trend.heading")}
          </h2>
          <Card>
            <CardContent className="h-56 py-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <XAxis dataKey="index" hide />
                  <YAxis
                    domain={[0, 100]}
                    width={28}
                    tick={{ fontSize: 11 }}
                    stroke="var(--color-muted)"
                  />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="movingAverage"
                    stroke="var(--color-success)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </section>
      )}

      {recent.length > 0 && (
        <section
          aria-labelledby="dashboard-recent"
          className="flex flex-col gap-3"
        >
          <h2
            id="dashboard-recent"
            className="font-serif text-lg font-semibold"
          >
            {t("recent.heading")}
          </h2>
          <ul className="flex flex-col gap-3">
            {recent.map((analysis) => (
              <li key={analysis.id}>
                <AnalysisRow analysis={analysis} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
