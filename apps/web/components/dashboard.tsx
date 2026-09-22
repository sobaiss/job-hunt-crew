"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight, Check, FileText, LayoutGrid, Link2 } from "lucide-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { AnalysisStatus, AnalysisSummary } from "@/hooks/use-analyses";
import { useAnalyses } from "@/hooks/use-analyses";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { useScouts } from "@/hooks/use-scouts";
import { useEnumLabel } from "@/lib/enum-labels";
import {
  analysesThisWeek,
  bestScoreOffer,
  computeStats,
  defaultCvLabel,
  newMatchesCount,
  onboardingSteps,
  scoreTrend,
  type OnboardingSteps,
} from "@/lib/dashboard-metrics";
import { cn } from "@/lib/utils";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { VariantProps } from "class-variance-authority";

/** How many recent analyses the Dashboard shows. */
const RECENT_LIMIT = 5;

/** Same COMPLETED/FAILED/running/queued grouping as `analysisBadgeVariant`
 *  (`analysis-row.tsx`), but onto the tinted `success`/`warning`/`danger`/
 *  `muted` Badge variants — the flat pill style used throughout the
 *  reviewed mockup (design/Shell.dc.html) rather than the solid
 *  `destructive` fill `analysisBadgeVariant` uses elsewhere in the app. */
const RECENT_BADGE_VARIANT: Record<
  AnalysisStatus,
  VariantProps<typeof badgeVariants>["variant"]
> = {
  COMPLETED: "success",
  FAILED: "danger",
  PENDING: "muted",
  QUEUED: "muted",
  RUNNING_CREW: "warning",
  AWAITING_RESULT: "warning",
  PERSISTING: "warning",
};

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: ReactNode;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="flex flex-col gap-1 px-5">
        <span className="text-sm text-muted">{label}</span>
        <span className="font-serif text-3xl font-semibold tabular-nums">
          {value}
        </span>
        {sub && <span className="truncate text-xs text-muted">{sub}</span>}
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

/** One row in the "Recent analyses" card: title + company/CV on the left,
 *  the Match score and a status pill on the right — the compact list style
 *  from the reviewed mockup (design/Shell.dc.html), stacked inside a single
 *  Card rather than one Card per row like `AnalysisRow`. */
function RecentAnalysisRow({ analysis }: { analysis: AnalysisSummary }) {
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");

  return (
    <Link
      href={`/analyses/${analysis.id}`}
      className="flex items-center justify-between gap-4 border-t border-border py-3 first:border-t-0 first:pt-0"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {analysis.jobOffer.title ?? t("jobOfferFallback")}
        </span>
        <span className="block truncate text-xs text-muted">
          {analysis.jobOffer.company ?? "—"} ·{" "}
          {analysis.jobOffer.location ?? "—"}
        </span>
        <span className="block truncate text-xs text-muted">
          {t("vsCv", { label: analysis.cvVersion.label })}
        </span>
      </span>
      <span className="flex flex-none items-center gap-3">
        <span
          className={cn(
            "font-serif text-lg font-semibold tabular-nums",
            analysis.matchScore === null && "text-muted",
          )}
        >
          {analysis.matchScore ?? "—"}
        </span>
        <Badge variant={RECENT_BADGE_VARIANT[analysis.status]}>
          {statusLabel(analysis.status)}
        </Badge>
      </span>
    </Link>
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
  const tAnalyses = useTranslations("analyses");
  const analysesQuery = useAnalyses();
  const cvVersionsQuery = useCvVersions();
  const scoutsQuery = useScouts();

  if (analysesQuery.isPending || cvVersionsQuery.isPending) {
    return (
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
        <h1 className="sr-only">{t("title")}</h1>
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
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
        <h1 className="sr-only">{t("title")}</h1>
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      </main>
    );
  }

  const analyses = analysesQuery.data ?? [];
  const activeCvVersions =
    cvVersionsQuery.data?.filter((cv) => cv.supersededById === null) ?? [];
  const stats = computeStats(analyses, activeCvVersions.length);
  const bestOffer = bestScoreOffer(analyses);
  const weekCount = analysesThisWeek(analyses);
  const defaultCv = defaultCvLabel(activeCvVersions);
  const steps = onboardingSteps(analyses, activeCvVersions.length);
  const trend = scoreTrend(analyses);
  const trendValues = trend.map((p) => p.movingAverage);
  // The `/api/analyses` list is already recency-ordered.
  const recent = analyses.slice(0, RECENT_LIMIT);
  const showOnboarding = analyses.length === 0;
  const newMatches = newMatchesCount(scoutsQuery.data ?? []);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <h1 className="sr-only">{t("title")}</h1>

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
              <Link href="/scouts">
                {t("matches.cta")}
                <ArrowRight aria-hidden="true" />
              </Link>
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
            sub={
              bestOffer &&
              t("stats.bestScoreOffer", {
                title: bestOffer.title ?? tAnalyses("jobOfferFallback"),
                company: bestOffer.company ?? "—",
              })
            }
          />
          <StatTile
            label={t("stats.analysisCount")}
            value={stats.analysisCount}
            sub={
              weekCount > 0 && t("stats.analysesThisWeek", { count: weekCount })
            }
          />
          <StatTile
            label={t("stats.cvVersionCount")}
            value={stats.cvVersionCount}
            sub={defaultCv && t("stats.defaultCvLabel", { label: defaultCv })}
          />
        </section>
      )}

      {recent.length > 0 && (
        <section
          aria-labelledby="dashboard-recent"
          className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
        >
          <Card className="py-5">
            <CardContent className="flex flex-col gap-1">
              <div className="mb-1 flex items-center justify-between">
                <h2
                  id="dashboard-recent"
                  className="font-serif text-base font-semibold"
                >
                  {t("recent.heading")}
                </h2>
                <Link href="/analyses" className="text-sm text-accent hover:underline">
                  {t("recent.viewAll")} →
                </Link>
              </div>
              <div className="flex flex-col">
                {recent.map((analysis) => (
                  <RecentAnalysisRow key={analysis.id} analysis={analysis} />
                ))}
              </div>
            </CardContent>
          </Card>

          {trend.length >= 2 && (
            <Card className="py-5">
              <CardContent className="flex h-full flex-col gap-2">
                <h2 className="font-serif text-base font-semibold">
                  {t("trend.heading")}
                </h2>
                <div className="h-40 flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend}>
                      <XAxis
                        dataKey="index"
                        hide
                      />
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
                </div>
                <p className="border-t border-border pt-3 text-xs text-muted">
                  {t("trend.caption", {
                    count: trend.length,
                    min: Math.min(...trendValues),
                    max: Math.max(...trendValues),
                  })}
                </p>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      <section aria-labelledby="dashboard-actions" className="flex flex-col gap-3">
        <h2
          id="dashboard-actions"
          className="text-xs font-semibold tracking-[0.06em] text-muted uppercase"
        >
          {t("quickActions.heading")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <QuickAction
            href="/analyses/new"
            Icon={Link2}
            title={t("quickActions.analyseOne")}
            description={t("quickActions.analyseOneHint")}
          />
          <QuickAction
            href="/analyses/new/several"
            Icon={LayoutGrid}
            title={t("quickActions.analyseSeveral")}
            description={t("quickActions.analyseSeveralHint")}
          />
          <QuickAction
            href="/cv-versions"
            Icon={FileText}
            title={t("quickActions.importCv")}
            description={t("quickActions.importCvHint")}
          />
        </div>
      </section>
    </main>
  );
}

function QuickAction({
  href,
  Icon,
  title,
  description,
}: {
  href: string;
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-panel"
    >
      <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-accent/12 text-accent">
        <Icon className="size-4.5" aria-hidden />
      </span>
      {/* `<div>`, not `<span>` — a quick action's title can otherwise share
       *  its exact text with an OnboardingChecklist item (both show while
       *  the Candidate has no Analysis yet, e.g. "Import a CV"), and the
       *  Dashboard test suite disambiguates the checklist's own item by its
       *  `<span>` tag. */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      </div>
    </Link>
  );
}
