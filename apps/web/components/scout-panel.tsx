"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChartColumn,
  CircleAlert,
  Hourglass,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";

import {
  SCOUT_RUN_COOLDOWN_MS,
  useRunScout,
  useScoutRuns,
  useScoutStats,
  useUpdateScout,
  type Scout,
  type ScoutStatus,
} from "@/hooks/use-scouts";
import { useBulkRequeueAnalyses } from "@/hooks/use-analyses";
import { useSiteConfigs } from "@/hooks/use-site-configs";
import { BffError } from "@/lib/bff-client";
import { ApplicationStatsHeader } from "@/components/application-stats-header";
import {
  FilterSupportNotice,
  jobFiltersFrom,
} from "@/components/job-filter-fields";
import { PanelSection } from "@/components/panel-section";
import { ScoutRunHistory } from "@/components/scout-run-history";
import { ScoutFinds } from "@/components/scout-finds";
import { ScoutRunStateBadge } from "@/components/scout-run-state-badge";
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
//
// The header carries the Run state (#227, docs/adr/0033) beside the
// lifecycle badge — both, never one instead of the other — and, while it is
// BLOCKED, the Blocked-analyses repair. It deliberately carries no progress
// fraction: the run counters belong to one run while the badge is scoped to
// the Scout, so the two could visibly disagree. The live counters stay in the
// run history below, which polls them.
//
// "Run now" has three faces (#229, the Run cooldown in apps/web/CONTEXT.md):
// working while the Run state is IN_FLIGHT, then "Available in X min" until
// an hour has passed since the latest run's `createdAt` — the clock the API
// rate-limits on, not `lastRunAt`, which the worker stamps separately — then
// itself. The 429 message stays as the backstop for a stale screen.

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
// for the enum-valued filters, the option label the picker showed.
const FILTER_LABEL_KEYS: Record<string, string> = {
  keywords: "keywordsLabel",
  location: "locationLabel",
  postedWithin: "postedWithinLabel",
  contractType: "contractTypeLabel",
  remote: "remoteLabel",
  experienceLevel: "experienceLevelLabel",
};
const ENUM_FILTER_KEYS = new Set(["postedWithin", "remote", "contractType"]);

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
  now,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  scout: Scout | null;
  cvLabel: string;
  /** When the Scout was fetched — the Run state's duration is judged against
   *  it, exactly as the Scouts list's Execution column does. */
  now: number;
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
  const tRunState = useTranslations("scouts.runState");
  const queryClient = useQueryClient();

  // Hooks are parameterized by scout id (mirroring the former ScoutDetailPage),
  // so an empty id while the panel is closed is harmless — no mutation fires
  // until a button inside the open panel is clicked, and the queries below
  // are `enabled: Boolean(id)`-guarded in their hooks.
  const run = useRunScout(scout?.id ?? "");
  const update = useUpdateScout(scout?.id ?? "");
  const stats = useScoutStats(scout?.id ?? "");
  const runs = useScoutRuns(scout?.id ?? "");

  // The runs come newest first; the latest one's creation starts the clock.
  const latestRunCreatedAt = runs.data?.[0]?.createdAt;
  const cooldownEndsAt = latestRunCreatedAt
    ? new Date(latestRunCreatedAt).getTime() + SCOUT_RUN_COOLDOWN_MS
    : null;
  const clock = useCooldownClock(cooldownEndsAt);
  const cooldownMinutes =
    cooldownEndsAt !== null && cooldownEndsAt > clock
      ? Math.ceil((cooldownEndsAt - clock) / 60_000)
      : null;
  const working = scout?.runState === "IN_FLIGHT";

  // The Blocked-analyses repair: the Analyses list's bulk requeue, fanned
  // over the ids the server judged blocked. No new endpoint and no quota —
  // the server re-checks its own stuck predicate per row, and Blocked is a
  // strict subset of it, so only a stale screen can see a refusal. That
  // count is kept per Scout so another panel never inherits it.
  const requeue = useBulkRequeueAnalyses();
  const [repairFailure, setRepairFailure] = useState<{
    scoutId: string;
    failed: number;
    total: number;
  } | null>(null);
  const repair = () => {
    if (!scout) return;
    const ids = scout.blockedAnalysisIds;
    setRepairFailure(null);
    requeue.mutate(ids, {
      onSuccess: ({ failedAnalysisIds }) => {
        if (failedAnalysisIds.length > 0) {
          setRepairFailure({
            scoutId: scout.id,
            failed: failedAnalysisIds.length,
            total: ids.length,
          });
        }
      },
      // The state moves on once the rows are re-driven; don't wait for the
      // next poll to take the button away.
      onSettled: () => queryClient.invalidateQueries({ queryKey: ["scouts"] }),
    });
  };

  // The same FilterSupport statement the Scout form shows, read from the
  // stored filters and the targeted sites (issue #211). Nothing is written
  // back: a key with no enabled SiteConfig simply carries no warning.
  // Fetched only once a Scout is actually open — the panel is mounted by the
  // Scouts page from the first render, and the catalogue is of no use to it
  // while it's closed.
  const siteConfigs = useSiteConfigs({ enabled: open && Boolean(scout) });
  const targetedSites = (siteConfigs.data ?? []).filter((site) =>
    scout?.targetSiteKeys.some((key) => key === site.siteKey),
  );

  const activeFilters = scout
    ? Object.entries(scout.filters).filter(
        ([, value]) =>
          value != null &&
          value !== "" &&
          !(Array.isArray(value) && value.length === 0),
      )
    : [];

  const runErrorMessage =
    run.error instanceof BffError && run.error.status === 429
      ? tRuns("rateLimited")
      : tRuns("runError");

  /** "Posted within: Last 7 days" — the form's field label, then the option
   *  label for the enum-valued filters and the stored text for the rest. A
   *  list (contract types) reads as its labels, comma-separated. */
  const filterChipText = (key: string, value: string | string[]) => {
    const labelKey = FILTER_LABEL_KEYS[key];
    const label = labelKey ? tFilters(labelKey) : key;
    const shown = (Array.isArray(value) ? value : [value])
      .map((v) => (ENUM_FILTER_KEYS.has(key) ? tIngestion(`${key}.${v}`) : v))
      .join(", ");
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
              <div
                data-slot="scout-panel-header"
                className="sticky top-0 z-10 flex shrink-0 flex-col gap-4 border-b border-border bg-background px-6 py-5"
              >
                <SheetHeader className="gap-2 pr-10">
                  <SheetTitle className="font-serif text-xl font-semibold">
                    {scout.label}
                  </SheetTitle>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Badge variant={statusVariant(scout.status)} className="w-fit">
                      {t(`status.${scout.status}`)}
                    </Badge>
                    <ScoutRunStateBadge
                      runState={scout.runState}
                      runStateSince={scout.runStateSince}
                      now={now}
                    />
                  </div>
                </SheetHeader>

                <div className="flex flex-wrap items-center gap-2">
                  {scout.status === "ACTIVE" && (
                    <Button
                      type="button"
                      className="shadow-sm"
                      disabled={
                        run.isPending || working || cooldownMinutes !== null
                      }
                      onClick={() => run.mutate()}
                    >
                      {run.isPending || working ? (
                        <LoaderCircle className="animate-spin" aria-hidden />
                      ) : cooldownMinutes !== null ? (
                        <Hourglass aria-hidden />
                      ) : (
                        <Play aria-hidden />
                      )}
                      {working
                        ? tRuns("working")
                        : run.isPending
                          ? tRuns("running")
                          : cooldownMinutes !== null
                            ? tRuns("availableIn", { minutes: cooldownMinutes })
                            : tRuns("runNow")}
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
                  {scout.runState === "BLOCKED" &&
                    scout.blockedAnalysisIds.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        className="shadow-xs"
                        disabled={requeue.isPending}
                        onClick={repair}
                      >
                        {requeue.isPending ? (
                          <LoaderCircle className="animate-spin" aria-hidden />
                        ) : (
                          <RotateCcw aria-hidden />
                        )}
                        {tRunState("repair", {
                          count: scout.blockedAnalysisIds.length,
                        })}
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
                {repairFailure && repairFailure.scoutId === scout.id && (
                  <PanelAlert>
                    {tRunState("repairPartialError", {
                      failed: repairFailure.failed,
                      total: repairFailure.total,
                    })}
                  </PanelAlert>
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
                              {filterChipText(
                                key,
                                Array.isArray(value) ? value : String(value),
                              )}
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
                    <div className="pb-4 empty:hidden">
                      <FilterSupportNotice
                        sites={targetedSites}
                        values={jobFiltersFrom(scout.filters)}
                      />
                    </div>
                  </PanelSection>

                  <ApplicationStatsHeader
                    stats={stats.data}
                    isPending={stats.isPending}
                    isError={stats.isError}
                    icon={ChartColumn}
                    title={t("detail.statsHeading")}
                  />
                </div>

                <ScoutFinds
                  scoutId={scout.id}
                  totalCount={scout.relevantFindsCount}
                />

                <ScoutRunHistory scoutId={scout.id} />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Now, for the Run cooldown — ticking only while a cooldown is running, so
 *  the countdown moves and the button comes back on its own once the hour is
 *  up, without the Scouts list having to poll for it. */
function useCooldownClock(endsAt: number | null): number {
  const [clock, setClock] = useState(() => Date.now());
  const running = endsAt !== null && endsAt > clock;
  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => setClock(Date.now());
    tick();
    if (!running) return;
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [endsAt, running]);
  return clock;
}
