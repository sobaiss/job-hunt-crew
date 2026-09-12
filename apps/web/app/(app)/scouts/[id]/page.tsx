"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useScout,
  useScoutFinds,
  useScoutRuns,
  useScoutStats,
  useRunScout,
  useUpdateScout,
  type ScoutRun,
  type ScoutRunStatus,
  type ScoutStatus,
} from "@/hooks/use-scouts";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { BffError } from "@/lib/bff-client";
import { AnalysisRow } from "@/components/analysis-row";
import { ApplicationStatsHeader } from "@/components/application-stats-header";
import { ScoutPatternsPanel } from "@/components/scout-patterns-panel";
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

function runStatusVariant(
  status: ScoutRunStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "PARTIALLY_COMPLETED") return "warning";
  if (status === "FAILED") return "destructive";
  return "secondary";
}

function RunHistory({ scoutId }: { scoutId: string }) {
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

function Finds({ scoutId }: { scoutId: string }) {
  const t = useTranslations("scouts.finds");
  const { data, isPending, isError } = useScoutFinds(scoutId);

  if (isPending) {
    return <Skeleton className="h-16 w-full" />;
  }

  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-3 py-6 text-sm">
          <h2 className="font-serif text-lg font-semibold">
            {t("relevantHeading")}
          </h2>
          {data.relevantFinds.length === 0 ? (
            <p className="text-muted">{t("relevantEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.relevantFinds.map((analysis) => (
                <li key={analysis.id}>
                  <AnalysisRow analysis={analysis} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data.lowFitFinds.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-6 text-sm">
            <h2 className="font-serif text-lg font-semibold">
              {t("lowFitHeading")}
            </h2>
            <ul className="flex flex-col gap-3">
              {data.lowFitFinds.map((analysis) => (
                <li key={analysis.id}>
                  <AnalysisRow analysis={analysis} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function ScoutDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("scouts");
  const tRuns = useTranslations("scouts.runs");
  const tSites = useTranslations("scouts.siteKeys");

  const { data: scout, isPending, isError } = useScout(params.id);
  const { data: cvVersions } = useCvVersions();
  const update = useUpdateScout(params.id);
  const run = useRunScout(params.id);
  const stats = useScoutStats(params.id);

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

  const runErrorMessage =
    run.error instanceof BffError && run.error.status === 429
      ? tRuns("rateLimited")
      : tRuns("runError");

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
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? tRuns("running") : tRuns("runNow")}
            </Button>
          )}
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

      {run.isError && (
        <p role="alert" className="text-sm text-destructive">
          {runErrorMessage}
        </p>
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

      <ApplicationStatsHeader
        stats={stats.data}
        isPending={stats.isPending}
        isError={stats.isError}
      />

      <RunHistory scoutId={scout.id} />

      <ScoutPatternsPanel scoutId={scout.id} />

      <Finds scoutId={scout.id} />

      <Link href="/scouts" className="text-sm text-accent underline">
        {t("detail.back")}
      </Link>
    </main>
  );
}
