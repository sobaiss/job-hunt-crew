"use client";

import { type RefObject } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  useRunScout,
  useScoutStats,
  useUpdateScout,
  type Scout,
  type ScoutStatus,
} from "@/hooks/use-scouts";
import { BffError } from "@/lib/bff-client";
import { ApplicationStatsHeader } from "@/components/application-stats-header";
import { ScoutPatternsPanel } from "@/components/scout-patterns-panel";
import { ScoutRunHistory } from "@/components/scout-run-history";
import { ScoutFinds } from "@/components/scout-finds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// The right-hand slide-over opened from a Scouts table row (issue #91). It
// now absorbs the full former `/scouts/[id]` detail page — Configuration,
// Statistiques, Historique des exécutions, Patterns, and Finds all render in
// place here instead of behind a "view full detail" link, which is why that
// route is gone (issue #92, superseding docs/adr/0006 — see
// docs/adr/0007-scout-panel-full-absorption.md for the reversal).

function statusVariant(
  status: ScoutStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PAUSED") return "warning";
  return "secondary";
}

export function ScoutPanel({
  scout,
  cvLabel,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  scout: Scout | null;
  cvLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row that opened this panel — focused again on close, since Radix's
   *  own default only restores focus to a `SheetTrigger` and this panel is
   *  opened programmatically from a table row instead. */
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("scouts");
  const tRuns = useTranslations("scouts.runs");
  const tSites = useTranslations("scouts.siteKeys");

  // Hooks are parameterized by scout id (mirroring the former ScoutDetailPage),
  // so an empty id while the panel is closed is harmless — no mutation fires
  // until a button inside the open panel is clicked, and the queries below
  // are `enabled: Boolean(id)`-guarded in their hooks.
  const run = useRunScout(scout?.id ?? "");
  const update = useUpdateScout(scout?.id ?? "");
  const stats = useScoutStats(scout?.id ?? "");

  const activeFilters = scout
    ? Object.entries(scout.filters).filter(
        ([, value]) => value != null && value !== "",
      )
    : [];

  const runErrorMessage =
    run.error instanceof BffError && run.error.status === 429
      ? tRuns("rateLimited")
      : tRuns("runError");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-6xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        {!scout && open && (
          <p role="status" className="text-sm text-muted">
            {t("detail.loading")}
          </p>
        )}

        {scout && (
          <>
            <SheetHeader className="gap-2">
              <SheetTitle>{scout.label}</SheetTitle>
              <Badge variant={statusVariant(scout.status)} className="w-fit">
                {t(`status.${scout.status}`)}
              </Badge>
            </SheetHeader>

            <div className="flex flex-col gap-3 text-sm">
              <h2 className="font-serif text-lg font-semibold">
                {t("detail.configHeading")}
              </h2>
              <dl className="flex flex-col gap-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">{t("detail.baseCv")}</dt>
                  <dd>{cvLabel}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">{t("detail.sites")}</dt>
                  <dd className="text-right">
                    {scout.targetSiteKeys.map((key) => tSites(key)).join(", ")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">{t("detail.threshold")}</dt>
                  <dd>{scout.matchThreshold}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">{t("detail.filters")}</dt>
                  <dd className="text-right">
                    {activeFilters.length > 0
                      ? activeFilters.map(([k, v]) => `${k}: ${v}`).join(", ")
                      : t("detail.noFilters")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">{t("detail.lastRun")}</dt>
                  <dd>
                    {scout.lastRunAt
                      ? new Date(scout.lastRunAt).toLocaleString()
                      : t("detail.neverRun")}
                  </dd>
                </div>
              </dl>
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

            <div className="flex flex-wrap items-center gap-4 border-t pt-4 text-sm">
              <Button asChild variant="outline" size="sm">
                <Link href={`/scouts/${scout.id}/edit`}>
                  {t("actions.edit")}
                </Link>
              </Button>
            </div>

            <div className="flex flex-col gap-3 text-sm">
              <h2 className="font-serif text-lg font-semibold">
                {t("detail.statsHeading")}
              </h2>
              <ApplicationStatsHeader
                stats={stats.data}
                isPending={stats.isPending}
                isError={stats.isError}
              />
            </div>

            <ScoutRunHistory scoutId={scout.id} />

            <ScoutPatternsPanel scoutId={scout.id} />

            <ScoutFinds scoutId={scout.id} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
