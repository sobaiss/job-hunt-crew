"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCreateSingleUrlIngestionJob,
  useIngestionJob,
  TERMINAL_INGESTION_STATUSES,
} from "@/hooks/use-ingestion-jobs";
import { useAnalyses } from "@/hooks/use-analyses";
import { CvVersionPicker } from "@/components/cv-version-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Submitted = { inputUrl: string; cvVersionId: string };

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

  useEffect(() => {
    if (analysisId && !navigated.current) {
      navigated.current = true;
      router.replace(`/analyses/${analysisId}`);
    }
  }, [analysisId, router]);

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
  const create = useCreateSingleUrlIngestionJob();
  const [cvVersionId, setCvVersionId] = useState("");
  const [ingestionJobId, setIngestionJobId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

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

  const onSubmit = handleSubmit((values) => {
    if (!cvVersionId) return;
    start({ inputUrl: values.inputUrl.trim(), cvVersionId });
  });

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
      ) : (
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
          />

          <Button
            type="submit"
            disabled={create.isPending || !cvVersionId}
            className="self-start"
          >
            {create.isPending ? t("submitting") : t("submit")}
          </Button>

          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("error")}
            </p>
          )}
        </form>
      )}
    </main>
  );
}
