"use client";

import { type RefObject, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ExternalLink,
  GitCompare,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";

import {
  TERMINAL_ANALYSIS_STATUSES,
  useCreateAnalysis,
  type AnalysisDetail,
} from "@/hooks/use-analyses";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { useSetApplicationStatus } from "@/hooks/use-applications";
import {
  TRACKING_STATUS_TRANSITIONS,
  trackingStatusBadgeVariant,
  trackingStatusIcon,
  trackingStatusOf,
} from "@/lib/tracking-status";
import { analysisBadgeVariant } from "@/components/analysis-row";
import { AnalysisResultView } from "@/components/analysis-result";
import { CvVersionPicker } from "@/components/cv-version-picker";
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
  const [relaunchCvVersionId, setRelaunchCvVersionId] = useState("");

  // Only an `external` candidate gets a choice of CV to relaunch with (#181);
  // every other Role keeps the single quota-warning confirm, reusing the
  // Analysis's own CV. A session with no Role defaults to the lowest
  // privilege, same convention as `lib/internal-api.ts`.
  const { data: session } = useSession();
  const isExternal = (session?.user?.role ?? "EXTERNAL") === "EXTERNAL";

  const tracking = analysis ? trackingStatusOf(analysis) : null;
  const result = analysis?.resultJSON ?? null;
  const isRelaunchable =
    analysis !== null && TERMINAL_ANALYSIS_STATUSES.has(analysis.status);

  // Fetched as soon as the Quick view can offer a relaunch, so the choice
  // below is ready by the time the candidate opens the confirmation.
  const { data: cvVersions } = useCvVersions({
    enabled: isExternal && isRelaunchable,
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRelaunchConfirming(false);
      setRelaunchCvVersionId("");
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
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
                <p>
                  {analysis.jobOffer.company ?? "—"} ·{" "}
                  {analysis.jobOffer.location ?? "—"}
                </p>
                {tracking !== null ? (
                  <Badge variant={trackingStatusBadgeVariant(tracking)}>
                    {trackingStatusLabel(tracking)}
                  </Badge>
                ) : (
                  <Badge variant={analysisBadgeVariant(analysis.status)}>
                    {pipelineStatusLabel(analysis.status)}
                  </Badge>
                )}
              </div>
            </SheetHeader>

            {/* The two ways on from this Quick view used to be bare accent
                links pinned below the result breakdown, a scroll away from
                the offer they belong to. They lead the sheet now, in one row
                with "Voir l'offre" — same row the detail page gives its own
                header actions. "Voir l'analyse complète" is the row's one
                `default`: it is where the Quick view is a preview of. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
              <Button asChild size="sm">
                <Link href={`/analyses/${analysis.id}`}>
                  {t("quickView.viewFullAnalysis")}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/analyses/compare/${analysis.jobOffer.id}`}>
                  <GitCompare aria-hidden="true" />
                  {t("compareLink")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a
                  href={analysis.jobOffer.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink aria-hidden="true" />
                  {t("quickView.viewOffer")}
                </a>
              </Button>
            </div>

            {tracking !== null && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  {TRACKING_STATUS_TRANSITIONS.filter(
                    (transition) => transition.trackingStatus !== tracking,
                  ).map((transition) => {
                    const Icon = trackingStatusIcon(transition.trackingStatus);
                    return (
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
                      <Icon aria-hidden="true" />
                      {trackingStatusLabel(transition.trackingStatus)}
                    </Button>
                    );
                  })}
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
                    {isExternal && (
                      <div className="w-full max-w-xs">
                        <CvVersionPicker
                          id="quick-view-relaunch-cv"
                          value={relaunchCvVersionId}
                          onChange={setRelaunchCvVersionId}
                        />
                      </div>
                    )}
                    <p className="text-sm text-muted">
                      {t("quickView.relaunchConfirm")}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          relaunch.isPending ||
                          (isExternal && !relaunchCvVersionId)
                        }
                        onClick={() =>
                          relaunch.mutate(
                            {
                              jobOfferId: analysis.jobOffer.id,
                              cvVersionId: isExternal
                                ? relaunchCvVersionId
                                : analysis.cvVersionId,
                            },
                            {
                              onSuccess: (data) => {
                                setRelaunchConfirming(false);
                                setRelaunchCvVersionId("");
                                queryClient.invalidateQueries({
                                  queryKey: ["analyses"],
                                });
                                onRelaunched(data.analysisId);
                              },
                            },
                          )
                        }
                      >
                        {relaunch.isPending ? (
                          <LoaderCircle className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Check aria-hidden="true" />
                        )}
                        {t("bulk.generateConfirmAction")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={relaunch.isPending}
                        onClick={() => {
                          setRelaunchConfirming(false);
                          setRelaunchCvVersionId("");
                        }}
                      >
                        <X aria-hidden="true" />
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
                    onClick={() => {
                      // Preselect the Analysis's own CVVersion when it is
                      // still a valid choice (non-superseded, CONVERTED);
                      // otherwise leave it blank for `CvVersionPicker`'s own
                      // fallback (the candidate's default CONVERTED CV).
                      if (isExternal) {
                        const ownCv = cvVersions?.find(
                          (cv) => cv.id === analysis.cvVersionId,
                        );
                        const ownCvValid =
                          ownCv &&
                          ownCv.supersededById === null &&
                          ownCv.conversionStatus === "CONVERTED";
                        setRelaunchCvVersionId(ownCvValid ? ownCv.id : "");
                      }
                      setRelaunchConfirming(true);
                    }}
                  >
                    <RotateCw aria-hidden="true" />
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
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
