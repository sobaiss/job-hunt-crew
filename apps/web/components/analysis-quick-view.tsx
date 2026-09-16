"use client";

import { type RefObject, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";

import {
  TERMINAL_ANALYSIS_STATUSES,
  useCreateAnalysis,
  type AnalysisDetail,
} from "@/hooks/use-analyses";
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
  onRelaunched,
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
  /** Called with the new Analysis's id after a successful "Relancer
   *  l'analyse" (#124) — the page switches the Quick view to it and
   *  invalidates the Analyses list so the new row appears there too. */
  onRelaunched: (newId: string) => void;
}) {
  const t = useTranslations("analyses");
  const td = useTranslations("analyses.detail");
  const queryClient = useQueryClient();
  const setApplicationStatus = useSetApplicationStatus();
  const relaunch = useCreateAnalysis();
  const [relaunchConfirming, setRelaunchConfirming] = useState(false);

  const tracking = analysis ? trackingStatusOf(analysis) : null;
  const result = analysis?.resultJSON ?? null;
  const isRelaunchable =
    analysis !== null && TERMINAL_ANALYSIS_STATUSES.has(analysis.status);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRelaunchConfirming(false);
      relaunch.reset();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-5xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        {!analysis && open && (
          <p role="status" className="text-sm text-muted">
            {td("loading")}
          </p>
        )}

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

            {isRelaunchable && (
              <div className="flex flex-col gap-2">
                {relaunchConfirming ? (
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-muted">
                      {t("quickView.relaunchConfirm")}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={relaunch.isPending}
                        onClick={() =>
                          relaunch.mutate(
                            {
                              jobOfferId: analysis.jobOffer.id,
                              cvVersionId: analysis.cvVersionId,
                            },
                            {
                              onSuccess: (data) => {
                                setRelaunchConfirming(false);
                                queryClient.invalidateQueries({
                                  queryKey: ["analyses"],
                                });
                                onRelaunched(data.analysisId);
                              },
                            },
                          )
                        }
                      >
                        {t("bulk.generateConfirmAction")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={relaunch.isPending}
                        onClick={() => setRelaunchConfirming(false)}
                      >
                        {t("bulk.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() => setRelaunchConfirming(true)}
                  >
                    {td("retry")}
                  </Button>
                )}
                {relaunch.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    {td("retryError")}
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
