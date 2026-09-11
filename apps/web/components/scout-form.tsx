"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useCreateScout,
  useUpdateScout,
  SCOUT_SITE_KEYS,
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_POSTED_WITHIN,
  type Scout,
} from "@/hooks/use-scouts";
import { CvVersionPicker } from "@/components/cv-version-picker";
import {
  JobFilterFields,
  EMPTY_JOB_FILTERS,
  jobFiltersFrom,
  toFilterPayload,
  type JobFilterValues,
} from "@/components/job-filter-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MATCH_THRESHOLD;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Shared create / edit form for a Scout. With no `scout` prop it creates one
 * (France Travail pre-checked, threshold 70, posted-within 7 days) and redirects
 * to the Scout list; given a `scout` it edits it and redirects to its detail
 * page. Slice 1 (#53) — Scouts do not run yet.
 */
export function ScoutForm({ scout }: { scout?: Scout }) {
  const t = useTranslations("scouts.form");
  const tSites = useTranslations("scouts.siteKeys");
  const router = useRouter();

  const isEdit = scout != null;
  const create = useCreateScout();
  const update = useUpdateScout(scout?.id ?? "");
  const mutation = isEdit ? update : create;

  const [label, setLabel] = useState(scout?.label ?? "");
  const [cvVersionId, setCvVersionId] = useState(scout?.cvVersionId ?? "");
  const [siteKeys, setSiteKeys] = useState<string[]>(
    scout?.targetSiteKeys ?? ["FRANCE_TRAVAIL"],
  );
  const [threshold, setThreshold] = useState(
    scout?.matchThreshold ?? DEFAULT_MATCH_THRESHOLD,
  );
  const [filters, setFilters] = useState<JobFilterValues>(() =>
    jobFiltersFrom(scout?.filters ?? {}, {
      ...EMPTY_JOB_FILTERS,
      postedWithin: DEFAULT_POSTED_WITHIN,
    }),
  );

  const [labelError, setLabelError] = useState<string | null>(null);
  const [sitesError, setSitesError] = useState<string | null>(null);

  function toggleSite(key: string) {
    setSiteKeys((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key],
    );
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    let ok = true;
    if (!trimmedLabel) {
      setLabelError(t("labelRequired"));
      ok = false;
    } else {
      setLabelError(null);
    }
    if (siteKeys.length === 0) {
      setSitesError(t("sitesRequired"));
      ok = false;
    } else {
      setSitesError(null);
    }
    if (!ok || !cvVersionId) return;

    const payload = {
      label: trimmedLabel,
      cvVersionId,
      targetSiteKeys: siteKeys,
      matchThreshold: clampThreshold(threshold),
      filters: toFilterPayload(filters),
    };

    mutation.mutate(payload, {
      onSuccess: (data) => {
        router.push(isEdit ? `/scouts/${data.scout.id}` : "/scouts");
      },
    });
  }

  return (
    <Card>
      <CardContent className="py-6">
        <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scout-label">{t("labelLabel")}</Label>
            <Input
              id="scout-label"
              type="text"
              placeholder={t("labelPlaceholder")}
              value={label}
              aria-invalid={labelError ? true : undefined}
              onChange={(e) => setLabel(e.target.value)}
            />
            {labelError && (
              <p role="alert" className="text-sm text-destructive">
                {labelError}
              </p>
            )}
          </div>

          <CvVersionPicker
            id="scout-cv"
            value={cvVersionId}
            onChange={setCvVersionId}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t("sitesLabel")}</legend>
            <p className="text-xs text-muted">{t("sitesHint")}</p>
            <div className="flex flex-col gap-1.5">
              {SCOUT_SITE_KEYS.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={siteKeys.includes(key)}
                    onChange={() => toggleSite(key)}
                  />
                  {tSites(key)}
                </label>
              ))}
            </div>
            {sitesError && (
              <p role="alert" className="text-sm text-destructive">
                {sitesError}
              </p>
            )}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scout-threshold">{t("thresholdLabel")}</Label>
            <Input
              id="scout-threshold"
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <p className="text-xs text-muted">{t("thresholdHint")}</p>
          </div>

          <JobFilterFields
            idPrefix="scout"
            values={filters}
            onChange={setFilters}
          />

          <Button
            type="submit"
            disabled={mutation.isPending || !cvVersionId}
            className="self-start"
          >
            {mutation.isPending
              ? isEdit
                ? t("saving")
                : t("submitting")
              : isEdit
                ? t("save")
                : t("submit")}
          </Button>

          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("error")}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
