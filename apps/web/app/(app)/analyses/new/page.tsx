"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCreateSingleUrlIngestionJob,
  useIngestionJob,
  isListingPageError,
  TERMINAL_INGESTION_STATUSES,
} from "@/hooks/use-ingestion-jobs";
import {
  useAnalyses,
  useCreateAnalysis,
  useKnownOfferShortcut,
} from "@/hooks/use-analyses";
import { BffError } from "@/lib/bff-client";
import { CvVersionPicker } from "@/components/cv-version-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Submitted = { inputUrl: string; cvVersionId: string };

/** The exact-(JobOffer, CVVersion) match found by the known-offer shortcut. */
type AlreadyAnalysed = { jobOfferId: string; analysisId: string };

/**
 * The waiting state after a SINGLE_URL IngestionJob is created: a two-step
 * progress indication ("fetching the offer", then "analysing") while the
 * ingestion worker scrapes the offer and creates the Analysis. Polls the
 * IngestionJob and its Analysis batch; routes to the Analysis detail view the
 * moment the Analysis exists, or shows a plain failure + retry if the fetch
 * failed. Keyed on `ingestionJobId` by the parent so a retry resets it.
 */
function WaitingState({
  ingestionJobId,
  onRetry,
  retrying,
}: {
  ingestionJobId: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations("analyseOne");
  const router = useRouter();
  const navigated = useRef(false);

  const job = useIngestionJob(ingestionJobId);
  const analyses = useAnalyses({ ingestionJobId });

  const analysisId = analyses.data?.[0]?.id ?? null;
  const jobFailed = job.data?.status === "FAILED";
  const looksLikeListing = isListingPageError(job.data?.errorMessage);

  useEffect(() => {
    if (analysisId && !navigated.current) {
      navigated.current = true;
      router.replace(`/analyses/${analysisId}`);
    }
  }, [analysisId, router]);

  if (jobFailed && !analysisId && looksLikeListing) {
    return (
      <div className="flex flex-col gap-4">
        <div
          role="alert"
          className="rounded-md border border-border bg-muted/10 p-4 text-sm"
        >
          {t("listing")}
        </div>
        <Button asChild className="self-start">
          <Link href="/analyses/new/several">{t("listingCta")}</Link>
        </Button>
      </div>
    );
  }

  if (jobFailed && !analysisId) {
    return (
      <div className="flex flex-col gap-4">
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {t("failed")}
        </div>
        <Button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="self-start"
        >
          {retrying ? t("submitting") : t("retry")}
        </Button>
      </div>
    );
  }

  const step1Done =
    analysisId !== null ||
    (job.data != null && TERMINAL_INGESTION_STATUSES.has(job.data.status));
  const step2Active = analysisId !== null;

  return (
    <div role="status" className="flex flex-col gap-3">
      <h2 className="font-serif text-xl font-semibold">{t("waitingHeading")}</h2>
      <ol className="flex flex-col gap-2 text-sm">
        <li className={step1Done ? "text-muted" : "font-medium"}>
          <span aria-hidden="true">{step1Done ? "✓ " : "→ "}</span>
          <span>{t("step1")}</span>
        </li>
        <li className={step2Active ? "font-medium" : "text-muted"}>
          <span aria-hidden="true">{step2Active ? "→ " : "· "}</span>
          <span>{t("step2")}</span>
        </li>
      </ol>
    </div>
  );
}

export default function AnalyseOneOfferPage() {
  const t = useTranslations("analyseOne");
  const tSeveral = useTranslations("analyseSeveral");
  const router = useRouter();
  const create = useCreateSingleUrlIngestionJob();
  const shortcut = useKnownOfferShortcut();
  const createAnalysis = useCreateAnalysis();
  const [cvVersionId, setCvVersionId] = useState("");
  const [ingestionJobId, setIngestionJobId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [alreadyAnalysed, setAlreadyAnalysed] = useState<AlreadyAnalysed | null>(
    null,
  );
  const [dailyCapReached, setDailyCapReached] = useState(false);

  const schema = z.object({
    inputUrl: z
      .string()
      .trim()
      .min(1, t("urlRequired"))
      .refine((value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      }, t("urlInvalid")),
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { inputUrl: "" },
  });

  const start = (values: Submitted) => {
    setSubmitted(values);
    create.mutate(values, {
      onSuccess: (data) => setIngestionJobId(data.ingestionJob.id),
    });
  };

  // Direct path: the URL already resolves to a READY JobOffer with no prior
  // analysis for this CV, or the candidate hit "Re-run". Creates one Analysis
  // via POST /api/analyses and routes straight to its detail view. A daily-cap
  // 429 is shown in place instead of navigating.
  const runDirect = async (jobOfferId: string) => {
    setDailyCapReached(false);
    try {
      const { analysisId } = await createAnalysis.mutateAsync({
        jobOfferId,
        cvVersionId,
      });
      router.replace(`/analyses/${analysisId}`);
    } catch (err) {
      if (err instanceof BffError && err.status === 429) {
        setDailyCapReached(true);
      }
      // Any other failure is surfaced by createAnalysis.isError below.
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    if (!cvVersionId) return;
    const inputUrl = values.inputUrl.trim();
    setDailyCapReached(false);

    let result;
    try {
      result = await shortcut.mutateAsync({ url: inputUrl, cvVersionId });
    } catch {
      return; // shortcut.isError renders the generic message
    }

    if (result.kind === "unknown") {
      start({ inputUrl, cvVersionId });
      return;
    }
    if (result.existingAnalysisId) {
      setAlreadyAnalysed({
        jobOfferId: result.jobOfferId,
        analysisId: result.existingAnalysisId,
      });
      return;
    }
    await runDirect(result.jobOfferId);
  });

  const busy = create.isPending || shortcut.isPending || createAnalysis.isPending;
  const genericError =
    !dailyCapReached &&
    (create.isError || shortcut.isError || createAnalysis.isError);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("heading")}</h1>
        <p className="text-sm text-muted">{t("subtitle")}</p>
      </div>

      {ingestionJobId ? (
        <WaitingState
          key={ingestionJobId}
          ingestionJobId={ingestionJobId}
          retrying={create.isPending}
          onRetry={() => {
            if (submitted) start(submitted);
          }}
        />
      ) : alreadyAnalysed ? (
        <div className="flex flex-col gap-4">
          <div
            role="status"
            className="rounded-md border border-border bg-muted/10 p-4 text-sm"
          >
            {t("rerunNote")}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" className="self-start">
              <Link href={`/analyses/${alreadyAnalysed.analysisId}`}>
                {t("rerunView")}
              </Link>
            </Button>
            <Button
              type="button"
              onClick={() => runDirect(alreadyAnalysed.jobOfferId)}
              disabled={createAnalysis.isPending}
              className="self-start"
            >
              {createAnalysis.isPending ? t("submitting") : t("rerun")}
            </Button>
          </div>
          {dailyCapReached && (
            <p role="alert" className="text-sm text-destructive">
              {t("dailyCap")}
            </p>
          )}
          {genericError && (
            <p role="alert" className="text-sm text-destructive">
              {t("error")}
            </p>
          )}
        </div>
      ) : (
        <>
          <nav className="flex gap-4 text-sm">
            <span aria-current="page" className="font-medium">
              {t("heading")}
            </span>
            <Link
              href="/analyses/new/several"
              className="text-muted hover:text-foreground"
            >
              {tSeveral("heading")}
            </Link>
          </nav>

          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="offer-url">{t("urlLabel")}</Label>
              <Input
                id="offer-url"
                type="url"
                placeholder={t("urlPlaceholder")}
                aria-invalid={errors.inputUrl ? true : undefined}
                {...register("inputUrl")}
              />
              {errors.inputUrl && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.inputUrl.message}
                </p>
              )}
            </div>

            <CvVersionPicker
              id="offer-cv"
              value={cvVersionId}
              onChange={setCvVersionId}
              allowImport
            />

            <Button
              type="submit"
              disabled={busy || !cvVersionId}
              className="self-start"
            >
              {busy ? t("submitting") : t("submit")}
            </Button>

            {dailyCapReached && (
              <p role="alert" className="text-sm text-destructive">
                {t("dailyCap")}
              </p>
            )}

            {genericError && (
              <p role="alert" className="text-sm text-destructive">
                {t("error")}
              </p>
            )}
          </form>
        </>
      )}
    </main>
  );
}
