"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import {
  Check,
  ExternalLink,
  GitCompare,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";

import {
  useAnalysis,
  useCreateAnalysis,
  useRequeueAnalysis,
  TERMINAL_ANALYSIS_STATUSES,
} from "@/hooks/use-analyses";
import { BffError } from "@/lib/bff-client";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { useEnumLabel } from "@/lib/enum-labels";
import { analysisBadgeVariant } from "@/components/analysis-row";
import { AnalysisResultView } from "@/components/analysis-result";
import { ApplicationAction } from "@/components/application-action";
import { CvVersionPicker } from "@/components/cv-version-picker";
import { GeneratedDocumentsPanel } from "@/components/generated-documents-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");
  const { data: analysis, isPending, isError } = useAnalysis(params.id);
  const rerun = useCreateAnalysis();
  const requeue = useRequeueAnalysis();
  const [relaunchConfirming, setRelaunchConfirming] = useState(false);
  const [relaunchCvVersionId, setRelaunchCvVersionId] = useState("");

  // Only an `external` candidate gets the confirm-with-CV-picker step
  // (issue #183, mirroring the Quick view's #181); every other Role keeps
  // the page's original one-click retry, unchanged. A session with no Role
  // defaults to the lowest privilege, same convention as `lib/internal-api.ts`.
  const { data: session } = useSession();
  const isExternal = (session?.user?.role ?? "EXTERNAL") === "EXTERNAL";

  const isFailed = analysis?.status === "FAILED";

  // Fetched as soon as the page can offer a relaunch, so the choice is
  // ready by the time the candidate opens the confirmation.
  const { data: cvVersions } = useCvVersions({
    enabled: isExternal && isFailed,
  });

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-6xl p-8">
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

  if (isError || !analysis) {
    return (
      <main className="mx-auto w-full max-w-6xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("detail.loadError")}
        </p>
      </main>
    );
  }

  const isTerminal = TERMINAL_ANALYSIS_STATUSES.has(analysis.status);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold sm:text-[1.75rem]">
            {analysis.jobOffer.title ?? t("jobOfferFallback")}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
            <p>
              {analysis.jobOffer.company ?? "—"} ·{" "}
              {analysis.jobOffer.location ?? "—"}
            </p>
            <span aria-hidden="true">·</span>
            <span>{t("vsCv", { label: analysis.cvVersion.label })}</span>
            <Badge variant={analysisBadgeVariant(analysis.status)}>
              {statusLabel(analysis.status)}
            </Badge>
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
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
          {/* A button, not the bare accent link it used to be — it sits in the
              same action row as "Voir l'offre" and does the same kind of job. */}
          <Button asChild variant="outline" size="sm">
            <Link href={`/analyses/compare/${analysis.jobOffer.id}`}>
              <GitCompare aria-hidden="true" />
              {t("compareLink")}
            </Link>
          </Button>
        </div>
      </div>

      {isFailed && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p>{t("detail.failed")}</p>
          {analysis.errorMessage && <p>{analysis.errorMessage}</p>}
          {rerun.data ? (
            <Link
              href={`/analyses/${rerun.data.analysisId}`}
              className="text-sm font-medium text-accent hover:underline"
            >
              {t("detail.retryStarted")}
            </Link>
          ) : isExternal && relaunchConfirming ? (
            <div className="flex flex-col items-start gap-2">
              <div className="w-full max-w-xs">
                <CvVersionPicker
                  id="detail-relaunch-cv"
                  value={relaunchCvVersionId}
                  onChange={setRelaunchCvVersionId}
                />
              </div>
              <p className="text-sm text-muted">{t("quickView.relaunchConfirm")}</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rerun.isPending || !relaunchCvVersionId}
                  onClick={() =>
                    rerun.mutate({
                      jobOfferId: analysis.jobOffer.id,
                      cvVersionId: relaunchCvVersionId,
                    })
                  }
                >
                  {rerun.isPending ? (
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
                  disabled={rerun.isPending}
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
              variant="outline"
              size="sm"
              onClick={() => {
                if (isExternal) {
                  // Preselect the Analysis's own CVVersion when it is still a
                  // valid choice (non-superseded, CONVERTED); otherwise leave
                  // it blank for `CvVersionPicker`'s own fallback (the
                  // candidate's default CONVERTED CV).
                  const ownCv = cvVersions?.find(
                    (cv) => cv.id === analysis.cvVersionId,
                  );
                  const ownCvValid =
                    ownCv &&
                    ownCv.supersededById === null &&
                    ownCv.conversionStatus === "CONVERTED";
                  setRelaunchCvVersionId(ownCvValid ? ownCv.id : "");
                  setRelaunchConfirming(true);
                  return;
                }
                rerun.mutate({
                  jobOfferId: analysis.jobOffer.id,
                  cvVersionId: analysis.cvVersionId,
                });
              }}
              disabled={rerun.isPending}
            >
              {rerun.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <RotateCw aria-hidden="true" />
              )}
              {t("detail.retry")}
            </Button>
          )}
          {rerun.isError && <p>{t("detail.retryError")}</p>}
        </div>
      )}

      {/* A worker or queue restart can orphan a non-terminal Analysis with no
          trace, leaving it "En attente" for good. The server derives `stuck`
          (docs/adr/0032) and this offers the one repair: re-drive the same row,
          no new Analysis, no quota. Rendered before the "still running" note
          below so the page never says both at once. */}
      {analysis.stuck && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p>{t("detail.stuck")}</p>
          {requeue.isSuccess ? (
            <p role="status">{t("detail.requeueStarted")}</p>
          ) : (
            <>
              <p className="text-muted">{t("detail.requeueHint")}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={requeue.isPending}
                onClick={() => requeue.mutate(analysis.id)}
              >
                {requeue.isPending ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCw aria-hidden="true" />
                )}
                {t("detail.requeue")}
              </Button>
            </>
          )}
          {requeue.isError && (
            <p>
              {requeue.error instanceof BffError && requeue.error.status === 409
                ? t("detail.requeueNotStuck")
                : t("detail.requeueError")}
            </p>
          )}
        </div>
      )}

      {!isTerminal && !analysis.stuck && (
        <p role="status" className="text-sm text-muted">
          {t("detail.running")}
        </p>
      )}

      {analysis.resultJSON ? (
        <AnalysisResultView result={analysis.resultJSON} />
      ) : (
        !isFailed && <p className="text-sm text-muted">{t("detail.noResult")}</p>
      )}

      {analysis.status === "COMPLETED" && (
        <>
          <ApplicationAction analysisId={analysis.id} sourceUrl={analysis.jobOffer.sourceUrl} />
          <GeneratedDocumentsPanel analysisId={analysis.id} />
        </>
      )}
    </main>
  );
}
