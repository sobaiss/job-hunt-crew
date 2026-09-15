"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";

import type { AnalysisDetail } from "@/hooks/use-analyses";
import { useSetApplicationStatus } from "@/hooks/use-applications";
import {
  TRACKING_STATUS_TRANSITIONS,
  trackingStatusBadgeVariant,
  trackingStatusOf,
} from "@/lib/tracking-status";
import { analysisBadgeVariant } from "@/components/analysis-row";
import { AnalysisResultView } from "@/components/analysis-result";
import { GeneratedDocumentsPanel } from "@/components/generated-documents-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// The read-only slide-over opened from an Analyses-table row (issue #65),
// widened to show the full Analysis result breakdown in place (issue #70) via
// the same `AnalysisResultView` the full detail page renders. Reads the same
// `resultJSON` the detail page already fetches — no dedicated endpoint.

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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-5xl"
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
              <p className="text-sm text-muted">
                {analysis.jobOffer.company ?? "—"} ·{" "}
                {analysis.jobOffer.location ?? "—"}
              </p>
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
              <AnalysisResultView result={result} />
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
