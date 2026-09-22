"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";

import {
  useAnalysis,
  useCreateAnalysis,
  TERMINAL_ANALYSIS_STATUSES,
} from "@/hooks/use-analyses";
import { useCvVersions } from "@/hooks/use-cv-versions";
import { useEnumLabel } from "@/lib/enum-labels";
import { AnalysisResultView } from "@/components/analysis-result";
import { ApplicationAction } from "@/components/application-action";
import { CvVersionPicker } from "@/components/cv-version-picker";
import { GeneratedDocumentsPanel } from "@/components/generated-documents-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("analyses");
  const statusLabel = useEnumLabel("analysisStatus");
  const { data: analysis, isPending, isError } = useAnalysis(params.id);
  const rerun = useCreateAnalysis();
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

  if (isError || !analysis) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("detail.loadError")}
        </p>
      </main>
    );
  }

  const isTerminal = TERMINAL_ANALYSIS_STATUSES.has(analysis.status);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">
          {analysis.jobOffer.title ?? t("jobOfferFallback")}
        </h1>
        <p className="text-sm text-muted">
          {analysis.jobOffer.company ?? "—"} ·{" "}
          {analysis.jobOffer.location ?? "—"}
        </p>
        <p className="text-sm text-muted">
          {t("vsCv", { label: analysis.cvVersion.label })} ·{" "}
          {statusLabel(analysis.status)}
        </p>
        <Link
          href={`/analyses/compare/${analysis.jobOffer.id}`}
          className="text-sm text-accent hover:underline"
        >
          {t("compareLink")}
        </Link>
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
                  {t("bulk.generateConfirmAction")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rerun.isPending}
                  onClick={() => {
                    setRelaunchConfirming(false);
                    setRelaunchCvVersionId("");
                  }}
                >
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
              {t("detail.retry")}
            </Button>
          )}
          {rerun.isError && <p>{t("detail.retryError")}</p>}
        </div>
      )}

      {!isTerminal && (
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
