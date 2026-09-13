"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";

import type { AnalysisDetail, MissingSkill } from "@/hooks/use-analyses";
import { useSetApplicationStatus } from "@/hooks/use-applications";
import {
  TRACKING_STATUS_TRANSITIONS,
  trackingStatusBadgeVariant,
  trackingStatusOf,
} from "@/lib/tracking-status";
import { analysisBadgeVariant } from "@/components/analysis-row";
import { GeneratedDocumentsPanel } from "@/components/generated-documents-panel";
import { MatchScoreGauge } from "@/components/match-score-gauge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// The read-only slide-over opened from an Analyses-table row (issue #65): a
// condensed read of one Analysis, linking out to the full detail page and the
// Side-by-side comparison for the exhaustive breakdown. Reads the same
// `resultJSON` the detail page already fetches — no dedicated endpoint.

/** Only the top few, not the full list — the exhaustive breakdown stays on
 *  the full Analysis detail page. */
const QUICK_VIEW_MAX_MISSING_SKILLS = 3;

const IMPORTANCE_RANK: Record<MissingSkill["importance"], number> = {
  required: 0,
  nice_to_have: 1,
};

export function AnalysisQuickView({
  analysis,
  open,
  onOpenChange,
  pipelineStatusLabel,
  trackingStatusLabel,
  returnFocusRef,
}: {
  analysis: AnalysisDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  /** The row that opened this Quick view — focused again on close since
   *  Radix's own default only restores focus to a `SheetTrigger`, and this
   *  Quick view is opened programmatically from a table row instead. */
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("analyses");
  const td = useTranslations("analyses.detail");
  const queryClient = useQueryClient();
  const setApplicationStatus = useSetApplicationStatus();

  const tracking = analysis ? trackingStatusOf(analysis) : null;
  const result = analysis?.resultJSON ?? null;
  const topMissingSkills = result
    ? [...result.missing_skills]
        .sort(
          (a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance],
        )
        .slice(0, QUICK_VIEW_MAX_MISSING_SKILLS)
    : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        {analysis && (
          <>
            <SheetHeader>
              <SheetTitle>
                {analysis.jobOffer.title ?? t("jobOfferFallback")}
              </SheetTitle>
              {analysis.jobOffer.company && (
                <p className="text-sm text-muted">{analysis.jobOffer.company}</p>
              )}
            </SheetHeader>

            <Button asChild variant="outline" size="sm" className="w-fit">
              <a
                href={analysis.jobOffer.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("quickView.viewOffer")}
              </a>
            </Button>

            {tracking !== null ? (
              <Badge
                variant={trackingStatusBadgeVariant(tracking)}
                className="self-start"
              >
                {trackingStatusLabel(tracking)}
              </Badge>
            ) : (
              <Badge
                variant={analysisBadgeVariant(analysis.status)}
                className="self-start"
              >
                {pipelineStatusLabel(analysis.status)}
              </Badge>
            )}

            {tracking !== null && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  {TRACKING_STATUS_TRANSITIONS.filter(
                    (transition) => transition.trackingStatus !== tracking,
                  ).map((transition) => (
                    <Button
                      key={transition.trackingStatus}
                      variant="outline"
                      size="sm"
                      disabled={setApplicationStatus.isPending}
                      onClick={() =>
                        setApplicationStatus.mutate(
                          {
                            analysisId: analysis.id,
                            status: transition.applicationStatus,
                          },
                          {
                            onSuccess: () =>
                              queryClient.invalidateQueries({
                                queryKey: ["analyses"],
                              }),
                          },
                        )
                      }
                    >
                      {trackingStatusLabel(transition.trackingStatus)}
                    </Button>
                  ))}
                </div>
                {setApplicationStatus.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    {t("quickView.statusError")}
                  </p>
                )}
              </div>
            )}

            {result ? (
              <>
                <section className="flex flex-col items-center gap-3">
                  <MatchScoreGauge score={result.match_score} />
                </section>

                <section className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold text-muted">
                    {td("summary")}
                  </h2>
                  <p className="text-sm leading-relaxed">{result.summary}</p>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold text-muted">
                    {td("missingSkills")}
                  </h2>
                  {topMissingSkills.length === 0 ? (
                    <p className="text-sm text-muted">{td("none")}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {topMissingSkills.map((item, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm">
                          <span className="font-medium">{item.skill}</span>
                          <Badge
                            variant={
                              item.importance === "required"
                                ? "warning"
                                : "secondary"
                            }
                          >
                            {td(`importance.${item.importance}`)}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            ) : (
              <p className="text-sm text-muted">{td("noResult")}</p>
            )}

            {analysis.status === "COMPLETED" && (
              <GeneratedDocumentsPanel analysisId={analysis.id} />
            )}

            <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
              <Link
                href={`/analyses/${analysis.id}`}
                className="text-sm font-medium text-accent hover:underline"
              >
                {t("quickView.viewFullAnalysis")}
              </Link>
              <Link
                href={`/analyses/compare/${analysis.jobOffer.id}`}
                className="text-sm font-medium text-accent hover:underline"
              >
                {t("compareLink")}
              </Link>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
