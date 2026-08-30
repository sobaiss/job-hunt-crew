"use client";

import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCreateIngestionJob,
  POSTED_WITHIN_VALUES,
  REMOTE_VALUES,
  type Remote,
} from "@/hooks/use-ingestion-jobs";
import { useSiteConfigs } from "@/hooks/use-site-configs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

// A styled native <select>: register()s straight into react-hook-form and is
// trivial to drive with user-event, unlike the Radix Select primitive. Matches
// the Input border/height so the form reads as one system.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

export default function NewSiteSearchIngestionJobPage() {
  const t = useTranslations("ingestion");
  const sites = useSiteConfigs();
  const create = useCreateIngestionJob();

  const schema = z.object({
    siteConfigId: z.string().min(1, t("new.siteRequired")),
    keywords: z.string(),
    location: z.string(),
    postedWithin: z.enum(POSTED_WITHIN_VALUES),
    contractType: z.string(),
    remote: z.string(),
    experienceLevel: z.string(),
  });

  const {
    register,
    handleSubmit,
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
    },
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate({
      siteConfigId: values.siteConfigId,
      filters: {
        keywords: values.keywords.trim() || undefined,
        location: values.location.trim() || undefined,
        postedWithin: values.postedWithin,
        contractType: values.contractType.trim() || undefined,
        remote: (values.remote || undefined) as Remote | undefined,
        experienceLevel: values.experienceLevel.trim() || undefined,
      },
    });
  });

  const createdId = create.data?.ingestionJob.id;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("new.heading")}</h1>
        <p className="text-sm text-muted">{t("new.subtitle")}</p>
      </div>

      {sites.isPending && (
        <div
          role="status"
          aria-label={t("new.siteLoading")}
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      )}

      {sites.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("new.siteLoadError")}
        </p>
      )}

      {sites.data && (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site">{t("new.siteLabel")}</Label>
            <select
              id="site"
              className={SELECT_CLASS}
              aria-invalid={errors.siteConfigId ? true : undefined}
              {...register("siteConfigId")}
            >
              <option value="" disabled>
                {t("new.sitePlaceholder")}
              </option>
              {sites.data.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.displayName}
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
            <Label htmlFor="keywords">{t("new.keywordsLabel")}</Label>
            <Input id="keywords" type="text" {...register("keywords")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="location">{t("new.locationLabel")}</Label>
            <Input id="location" type="text" {...register("location")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="postedWithin">{t("new.postedWithinLabel")}</Label>
            <select
              id="postedWithin"
              className={SELECT_CLASS}
              {...register("postedWithin")}
            >
              {POSTED_WITHIN_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`postedWithin.${value}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contractType">{t("new.contractTypeLabel")}</Label>
            <Input id="contractType" type="text" {...register("contractType")} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote">{t("new.remoteLabel")}</Label>
            <select
              id="remote"
              className={SELECT_CLASS}
              {...register("remote")}
            >
              <option value="">{t("new.remoteAny")}</option>
              {REMOTE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`remote.${value}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="experienceLevel">
              {t("new.experienceLevelLabel")}
            </Label>
            <Input
              id="experienceLevel"
              type="text"
              {...register("experienceLevel")}
            />
          </div>

          <Button
            type="submit"
            disabled={create.isPending}
            className="self-start"
          >
            {create.isPending ? t("new.submitting") : t("new.submit")}
          </Button>

          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("new.error")}
            </p>
          )}

          {createdId && (
            <p role="status" className="text-sm text-success">
              {t("new.success")}{" "}
              <Link
                href={`/ingestion-jobs/${createdId}`}
                className="text-accent underline"
              >
                {t("new.viewJob")}
              </Link>
            </p>
          )}
        </form>
      )}
    </main>
  );
}
