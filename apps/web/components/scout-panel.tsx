"use client";

import { type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Archive,
  ChartColumn,
  CircleAlert,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  SlidersHorizontal,
} from "lucide-react";

import {
  useRunScout,
  useScoutStats,
  useUpdateScout,
  type Scout,
  type ScoutStatus,
} from "@/hooks/use-scouts";
import { BffError } from "@/lib/bff-client";
import { ApplicationStatsHeader } from "@/components/application-stats-header";
import { PanelSection } from "@/components/panel-section";
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
// absorbs the full former `/scouts/[id]` detail page — Configuration,
// Statistiques, Historique des exécutions and Résultats pertinents all render
// in place here instead of behind a "view full detail" link, which is why
// that route is gone (issue #92, superseding docs/adr/0006 — see
// docs/adr/0007-scout-panel-full-absorption.md for the reversal).
//
// Layout: a sticky header carrying the identity (label + status) and every
// action, then Configuration and Statistiques paired on one row — how it's
// set up next to how it's doing — then the payoff (Résultats pertinents)
// full-width, and the audit trail (Historique) last. On a narrow viewport
// the grid collapses and that order is exactly the reading priority.

function statusVariant(
  status: ScoutStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PAUSED") return "warning";
  return "secondary";
}

// Configuration shows a Scout's filters under the same names the Scout form
// used to set them (`JobFilterFields`), rather than the raw `ScoutFilters`
// keys the API stores — no new messages, just the form's own labels and,
// for the two enum-valued filters, the option label the picker showed.
const FILTER_LABEL_KEYS: Record<string, string> = {
  keywords: "keywordsLabel",
  location: "locationLabel",
  postedWithin: "postedWithinLabel",
  contractType: "contractTypeLabel",
  remote: "remoteLabel",
  experienceLevel: "experienceLevelLabel",
};
const ENUM_FILTER_KEYS = new Set(["postedWithin", "remote"]);

/** One `<dt>`/`<dd>` pair of the Configuration list. Two columns rather than
 *  a wrapping flex row, so a value that needs several lines (a long site or
 *  filter list) stacks beside its label instead of underneath it. */
function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-1 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center justify-end gap-1.5 text-right">
        {children}
      </dd>
    </div>
  );
}

/** An inline error under the action bar. Each kind gets its own `role="alert"`
 *  element so a failed run and a failed status patch can both be announced. */
function PanelAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
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
  const tFilters = useTranslations("jobFilters");
  const tIngestion = useTranslations("ingestion");

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

  /** "Posted within: Last 7 days" — the form's field label, then the option
   *  label for the enum-valued filters and the stored text for the rest. */
  const filterChipText = (key: string, value: string) => {
    const labelKey = FILTER_LABEL_KEYS[key];
    const label = labelKey ? tFilters(labelKey) : key;
    const shown = ENUM_FILTER_KEYS.has(key)
      ? tIngestion(`${key}.${value}`)
      : value;
    return `${label}: ${shown}`;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* The sheet itself doesn't scroll — the inner wrapper does. That keeps
          Radix's absolutely-positioned close button pinned to the panel's
          corner instead of scrolling away under the sticky header below. */}
      <SheetContent
        className="w-full gap-0 overflow-hidden p-0 sm:max-w-6xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {!scout && open && (
            <p role="status" className="p-6 text-sm text-muted">
              {t("detail.loading")}
            </p>
          )}

          {scout && (
            <>
              {/* Stays put while the sections below scroll, so Run now / Pause /
                  Archive are always one click away however long the finds list
                  gets — the density cost docs/adr/0007 accepted. */}
              <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-4 border-b border-border bg-background px-6 py-5">
                <SheetHeader className="gap-2 pr-10">
                  <SheetTitle className="font-serif text-xl font-semibold">
                    {scout.label}
                  </SheetTitle>
                  <Badge variant={statusVariant(scout.status)} className="w-fit">
                    {t(`status.${scout.status}`)}
                  </Badge>
                </SheetHeader>

                <div className="flex flex-wrap items-center gap-2">
                  {scout.status === "ACTIVE" && (
                    <Button
                      type="button"
                      className="shadow-sm"
                      disabled={run.isPending}
                      onClick={() => run.mutate()}
                    >
                      {run.isPending ? (
                        <LoaderCircle className="animate-spin" aria-hidden />
                      ) : (
                        <Play aria-hidden />
                      )}
                      {run.isPending ? tRuns("running") : tRuns("runNow")}
                    </Button>
                  )}
                  {scout.status === "ACTIVE" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="shadow-xs"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ status: "PAUSED" })}
                    >
                      <Pause aria-hidden />
                      {t("actions.pause")}
                    </Button>
                  )}
                  {scout.status === "PAUSED" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="shadow-xs"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ status: "ACTIVE" })}
                    >
                      <Play aria-hidden />
                      {t("actions.resume")}
                    </Button>
                  )}
                  <Button asChild variant="outline" className="shadow-xs">
                    <Link href={`/scouts/${scout.id}/edit`}>
                      <Pencil aria-hidden />
                      {t("actions.edit")}
                    </Link>
                  </Button>
                  {scout.status !== "ARCHIVED" && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="ml-auto"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ status: "ARCHIVED" })}
                    >
                      <Archive aria-hidden />
                      {t("actions.archive")}
                    </Button>
                  )}
                </div>

                {run.isError && <PanelAlert>{runErrorMessage}</PanelAlert>}
                {update.isError && (
                  <PanelAlert>{t("actions.updateError")}</PanelAlert>
                )}
              </div>

              <div className="flex flex-col gap-6 px-6 py-6">
                <div className="grid items-start gap-6 lg:grid-cols-2">
                  <PanelSection
                    icon={SlidersHorizontal}
                    title={t("detail.configHeading")}
                    bodyClassName="px-5 py-1"
                  >
                    <dl className="divide-y divide-border">
                      <ConfigRow label={t("detail.baseCv")}>
                        <span className="font-medium">{cvLabel}</span>
                      </ConfigRow>
                      <ConfigRow label={t("detail.sites")}>
                        {scout.targetSiteKeys.map((key) => (
                          <Badge key={key} variant="muted">
                            {tSites(key)}
                          </Badge>
                        ))}
                      </ConfigRow>
                      <ConfigRow label={t("detail.threshold")}>
                        <span className="font-semibold tabular-nums">
                          {scout.matchThreshold}
                        </span>
                        {/* Neutral fill, not a score band: a threshold is a
                            setting, and DESIGN.md reserves success/warning/danger
                            for the bands themselves. */}
                        <span
                          className="h-1.5 w-16 overflow-hidden rounded-full bg-border"
                          aria-hidden
                        >
                          <span
                            className="block h-full rounded-full bg-foreground/60"
                            style={{ width: `${scout.matchThreshold}%` }}
                          />
                        </span>
                      </ConfigRow>
                      <ConfigRow label={t("detail.filters")}>
                        {activeFilters.length > 0 ? (
                          activeFilters.map(([key, value]) => (
                            <Badge key={key} variant="muted">
                              {filterChipText(key, String(value))}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-muted">{t("detail.noFilters")}</span>
                        )}
                      </ConfigRow>
                      <ConfigRow label={t("detail.lastRun")}>
                        {scout.lastRunAt ? (
                          new Date(scout.lastRunAt).toLocaleString()
                        ) : (
                          <span className="text-muted">{t("detail.neverRun")}</span>
                        )}
                      </ConfigRow>
                    </dl>
                  </PanelSection>

                  <ApplicationStatsHeader
                    stats={stats.data}
                    isPending={stats.isPending}
                    isError={stats.isError}
                    icon={ChartColumn}
                    title={t("detail.statsHeading")}
                  />
                </div>

                <ScoutFinds scoutId={scout.id} />

                <ScoutRunHistory scoutId={scout.id} />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
