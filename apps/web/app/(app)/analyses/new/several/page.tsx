"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCreateIngestionJob,
  useIngestionJob,
  INGESTION_MAX_OFFERS,
  POSTED_WITHIN_VALUES,
  REMOTE_VALUES,
  TERMINAL_INGESTION_STATUSES,
  type Remote,
} from "@/hooks/use-ingestion-jobs";
import {
  useAnalyses,
  useAnalysisQuota,
  TERMINAL_ANALYSIS_STATUSES,
  type AnalysisDetail,
  type AnalysisStatus,
} from "@/hooks/use-analyses";
import { useSiteConfigs, siteReliability } from "@/hooks/use-site-configs";
import { useEnumLabel } from "@/lib/enum-labels";
import { CvVersionPicker } from "@/components/cv-version-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

// Matches the SITE_SEARCH form's original styled native <select> so the two
// "New analysis" screens read as one system and are trivial to drive with
// user-event.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

function badgeVariant(
  status: AnalysisStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING" || status === "QUEUED") return "secondary";
  return "warning";
}

/** Best Match score first; an Analysis with no score yet sorts last. */
function byScoreDesc(a: AnalysisDetail, b: AnalysisDetail): number {
  return (b.matchScore ?? -1) - (a.matchScore ?? -1);
}

/**
 * The Batch result view: a two-phase progress header (offers discovered, then
 * analyses completed) above the batch's Analyses ranked by Match score, each
 * row linking to its Analysis detail. Polls the IngestionJob and its Analysis
 * batch, stopping once the job is terminal and every Analysis in it is too. A
 * run that found nothing, or where every fetch failed, shows a clear message
 * instead of a silently empty list; a discreet link drops to the raw
 * scraping-progress page.
 */
function BatchResultView({ ingestionJobId }: { ingestionJobId: string }) {
  const t = useTranslations("analyseSeveral");
  const statusLabel = useEnumLabel("analysisStatus");

  const job = useIngestionJob(ingestionJobId);
  const jobTerminal =
    job.data != null && TERMINAL_INGESTION_STATUSES.has(job.data.status);

  const analysesQuery = useAnalyses({
    ingestionJobId,
    batchRunning: !jobTerminal,
  });

  const analyses = useMemo(
    () => [...(analysesQuery.data ?? [])].sort(byScoreDesc),
    [analysesQuery.data],
  );

  const discovered = job.data?.discoveredCount ?? 0;
  const completed = analyses.filter((a) =>
    TERMINAL_ANALYSIS_STATUSES.has(a.status),
  ).length;

  // Offers the fan-out left unanalysed because the owner hit their daily cap.
  // The IngestionJob only records how many (`quotaSkippedCount`); pair that
  // count with the trailing READY offers that have no Analysis so each row can
  // name its offer, falling back to a bare marker when the job detail lags.
  const quotaSkippedCount = job.data?.quotaSkippedCount ?? 0;
  const quotaSkippedRows = useMemo(() => {
    if (quotaSkippedCount === 0) return [];
    const analysedOfferIds = new Set(analyses.map((a) => a.jobOffer.id));
    const unanalysed = (job.data?.jobOffers ?? [])
      .map((entry) => entry.jobOffer)
      .filter(
        (offer) =>
          offer.extractionStatus === "READY" &&
          !analysedOfferIds.has(offer.id),
      );
    return Array.from({ length: quotaSkippedCount }, (_, i) => ({
      key: unanalysed[i]?.id ?? `quota-skipped-${i}`,
      title: unanalysed[i]?.title ?? null,
      company: unanalysed[i]?.company ?? null,
    }));
  }, [quotaSkippedCount, analyses, job.data?.jobOffers]);

  const emptyRun =
    jobTerminal && analyses.length === 0 && quotaSkippedRows.length === 0
      ? job.data?.status === "FAILED" || (job.data?.failedCount ?? 0) > 0
        ? "allFailed"
        : "empty"
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div role="status" className="flex flex-col gap-2">
        <h2 className="font-serif text-xl font-semibold">
          {t("progressHeading")}
        </h2>
        <dl className="flex gap-6 text-sm">
          <div className="flex flex-col">
            <dt className="text-muted">{t("discovered")}</dt>
            <dd className="text-lg font-semibold tabular-nums">{discovered}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted">{t("analysesDone")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {completed} / {analyses.length}
            </dd>
          </div>
        </dl>
      </div>

      {emptyRun && (
        <p role="alert" className="text-sm text-muted">
          {t(emptyRun)}
        </p>
      )}

      {analyses.length > 0 && (
        <ul className="flex flex-col gap-3">
          {analyses.map((analysis) => (
            <li key={analysis.id}>
              <Card className="py-0 transition-colors hover:bg-panel">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <Link
                    href={`/analyses/${analysis.id}`}
                    className="flex min-w-0 flex-col"
                  >
                    <span className="truncate font-medium">
                      {analysis.jobOffer.title ?? t("jobOfferFallback")}
                    </span>
                    {analysis.jobOffer.company && (
                      <span className="truncate text-sm text-muted">
                        {analysis.jobOffer.company}
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {t("vsCv", { label: analysis.cvVersion.label })}
                    </span>
                  </Link>
                  <div className="flex shrink-0 items-center gap-3">
                    {analysis.matchScore !== null && (
                      <span className="text-lg font-semibold tabular-nums">
                        {analysis.matchScore}
                      </span>
                    )}
                    <Badge variant={badgeVariant(analysis.status)}>
                      {statusLabel(analysis.status)}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {quotaSkippedRows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {quotaSkippedRows.map((row) => (
            <li key={row.key}>
              <Card className="py-0">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {row.title ?? t("jobOfferFallback")}
                    </span>
                    {row.company && (
                      <span className="truncate text-sm text-muted">
                        {row.company}
                      </span>
                    )}
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {t("quotaSkipped")}
                  </Badge>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/ingestion-jobs/${ingestionJobId}`}
        className="text-xs text-accent hover:underline"
      >
        {t("scrapingDetail")}
      </Link>
    </div>
  );
}

export default function AnalyseSeveralOffersPage() {
  const t = useTranslations("analyseSeveral");
  const tIng = useTranslations("ingestion");
  const tOne = useTranslations("analyseOne");
  const reliabilityLabel = useTranslations("analyseSeveral.reliability");

  const sites = useSiteConfigs();
  const quota = useAnalysisQuota();
  const create = useCreateIngestionJob();
  const [cvVersionId, setCvVersionId] = useState("");
  const [ingestionJobId, setIngestionJobId] = useState<string | null>(null);

  const schema = z.object({
    siteConfigId: z.string().min(1, t("siteRequired")),
    keywords: z.string(),
    location: z.string(),
    postedWithin: z.enum(POSTED_WITHIN_VALUES),
    contractType: z.string(),
    remote: z.string(),
    experienceLevel: z.string(),
    // Kept lenient here — an out-of-range or blank field is clamped to
    // `1..INGESTION_MAX_OFFERS` on submit (services/api clamps again).
    maxOffers: z.number().catch(INGESTION_MAX_OFFERS),
  });

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      siteConfigId: "",
      keywords: "",
      location: "",
      postedWithin: "any",
      contractType: "",
      remote: "",
      experienceLevel: "",
      maxOffers: 10,
    },
  });

  const clampOffers = (value: number) =>
    Math.min(Math.max(1, Math.round(value || 1)), INGESTION_MAX_OFFERS);

  // What the pre-submit estimate shows: the offer count the form would submit
  // right now, before it is clamped again on submit / by services/api.
  const watchedMaxOffers = useWatch({ control, name: "maxOffers" });
  const plannedOffers = clampOffers(watchedMaxOffers);

  const onSubmit = handleSubmit((values) => {
    if (!cvVersionId) return;
    const maxOffers = clampOffers(values.maxOffers);
    create.mutate(
      {
        siteConfigId: values.siteConfigId,
        cvVersionId,
        maxOffers,
        filters: {
          keywords: values.keywords.trim() || undefined,
          location: values.location.trim() || undefined,
          postedWithin: values.postedWithin,
          contractType: values.contractType.trim() || undefined,
          remote: (values.remote || undefined) as Remote | undefined,
          experienceLevel: values.experienceLevel.trim() || undefined,
        },
      },
      { onSuccess: (data) => setIngestionJobId(data.ingestionJob.id) },
    );
  });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("heading")}</h1>
        <p className="text-sm text-muted">{t("subtitle")}</p>
      </div>

      {ingestionJobId ? (
        <BatchResultView key={ingestionJobId} ingestionJobId={ingestionJobId} />
      ) : (
        <>
          <nav className="flex gap-4 text-sm">
            <Link
              href="/analyses/new"
              className="text-muted hover:text-foreground"
            >
              {tOne("heading")}
            </Link>
            <span aria-current="page" className="font-medium">
              {t("heading")}
            </span>
          </nav>

          {sites.isPending && (
            <div
              role="status"
              aria-label={t("siteLoading")}
              className="flex flex-col gap-3"
            >
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          )}

          {sites.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("siteLoadError")}
            </p>
          )}

          {sites.data && (
            <form
              className="flex flex-col gap-4"
              onSubmit={onSubmit}
              noValidate
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="site">{t("siteLabel")}</Label>
                <select
                  id="site"
                  className={SELECT_CLASS}
                  aria-invalid={errors.siteConfigId ? true : undefined}
                  {...register("siteConfigId")}
                >
                  <option value="" disabled>
                    {t("sitePlaceholder")}
                  </option>
                  {sites.data.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.displayName} —{" "}
                      {reliabilityLabel(siteReliability(site))}
                    </option>
                  ))}
                </select>
                {errors.siteConfigId && (
                  <p role="alert" className="text-sm text-destructive">
                    {errors.siteConfigId.message}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="keywords">{t("keywordsLabel")}</Label>
                <Input id="keywords" type="text" {...register("keywords")} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="location">{t("locationLabel")}</Label>
                <Input id="location" type="text" {...register("location")} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="postedWithin">{t("postedWithinLabel")}</Label>
                <select
                  id="postedWithin"
                  className={SELECT_CLASS}
                  {...register("postedWithin")}
                >
                  {POSTED_WITHIN_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {tIng(`postedWithin.${value}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="contractType">{t("contractTypeLabel")}</Label>
                <Input
                  id="contractType"
                  type="text"
                  {...register("contractType")}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="remote">{t("remoteLabel")}</Label>
                <select
                  id="remote"
                  className={SELECT_CLASS}
                  {...register("remote")}
                >
                  <option value="">{t("remoteAny")}</option>
                  {REMOTE_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {tIng(`remote.${value}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="experienceLevel">
                  {t("experienceLevelLabel")}
                </Label>
                <Input
                  id="experienceLevel"
                  type="text"
                  {...register("experienceLevel")}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="maxOffers">{t("maxOffersLabel")}</Label>
                <Input
                  id="maxOffers"
                  type="number"
                  min={1}
                  max={INGESTION_MAX_OFFERS}
                  {...register("maxOffers", { valueAsNumber: true })}
                />
                <p className="text-xs text-muted">
                  {t("maxOffersHint", { max: INGESTION_MAX_OFFERS })}
                </p>
                {quota.data && (
                  <p role="status" className="text-xs text-muted">
                    {t("quotaEstimate", {
                      count: plannedOffers,
                      remaining: quota.data.remaining,
                    })}
                  </p>
                )}
              </div>

              <CvVersionPicker
                id="several-cv"
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
        </>
      )}
    </main>
  );
}
