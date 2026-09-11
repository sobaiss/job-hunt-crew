"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCreateIngestionJob,
  INGESTION_MAX_OFFERS,
} from "@/hooks/use-ingestion-jobs";
import { useAnalysisQuota } from "@/hooks/use-analyses";
import { useSiteConfigs, siteReliability } from "@/hooks/use-site-configs";
import { BatchResultView } from "@/components/batch-result-view";
import { CvVersionPicker } from "@/components/cv-version-picker";
import {
  JobFilterFields,
  EMPTY_JOB_FILTERS,
  toFilterPayload,
  type JobFilterValues,
} from "@/components/job-filter-fields";
import {
  SUBNAV_CLASS,
  SUBNAV_ACTIVE_CLASS,
  SUBNAV_LINK_CLASS,
} from "@/components/matching-subnav";
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

export default function AnalyseSeveralOffersPage() {
  const t = useTranslations("analyseSeveral");
  const tOne = useTranslations("analyseOne");
  const reliabilityLabel = useTranslations("analyseSeveral.reliability");

  const sites = useSiteConfigs();
  const quota = useAnalysisQuota();
  const create = useCreateIngestionJob();
  const [cvVersionId, setCvVersionId] = useState("");
  const [ingestionJobId, setIngestionJobId] = useState<string | null>(null);
  const [filters, setFilters] = useState<JobFilterValues>(EMPTY_JOB_FILTERS);

  const schema = z.object({
    siteConfigId: z.string().min(1, t("siteRequired")),
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
        filters: toFilterPayload(filters),
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
          <nav className={SUBNAV_CLASS}>
            <Link href="/analyses/new" className={SUBNAV_LINK_CLASS}>
              {tOne("heading")}
            </Link>
            <span aria-current="page" className={SUBNAV_ACTIVE_CLASS}>
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
            <Card>
              <CardContent className="py-6">
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

                  <JobFilterFields
                    idPrefix="several"
                    values={filters}
                    onChange={setFilters}
                  />

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
              </CardContent>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
