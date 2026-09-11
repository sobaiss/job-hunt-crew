"use client";

import { useTranslations } from "next-intl";

import {
  POSTED_WITHIN_VALUES,
  REMOTE_VALUES,
  type PostedWithin,
  type Remote,
  type SiteSearchFilters,
} from "@/hooks/use-ingestion-jobs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Mirrors the styled native <select> the "Analyse several offers" and Scout
// forms already use so the two screens read as one system and stay trivial to
// drive with user-event.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The job-search filter fields shared by "Analyse several offers" and the Scout
 * form (issue #53 prefactor). Fully controlled: the parent owns the state and
 * decides how it is stored (react-hook-form, useState, …).
 */
export type JobFilterValues = {
  keywords: string;
  location: string;
  postedWithin: PostedWithin;
  contractType: string;
  remote: "" | Remote;
  experienceLevel: string;
};

export const EMPTY_JOB_FILTERS: JobFilterValues = {
  keywords: "",
  location: "",
  postedWithin: "any",
  contractType: "",
  remote: "",
  experienceLevel: "",
};

/**
 * Build the `filters` object services/api accepts from the form state: free-text
 * fields are trimmed and dropped when blank; `postedWithin` is always sent.
 */
export function toFilterPayload(values: JobFilterValues): SiteSearchFilters {
  return {
    keywords: values.keywords.trim() || undefined,
    location: values.location.trim() || undefined,
    postedWithin: values.postedWithin,
    contractType: values.contractType.trim() || undefined,
    remote: values.remote || undefined,
    experienceLevel: values.experienceLevel.trim() || undefined,
  };
}

/** Seed {@link JobFilterValues} from a stored Scout's nullable `filters`. */
export function jobFiltersFrom(
  filters: Partial<Record<keyof JobFilterValues, string | null | undefined>>,
  fallback: JobFilterValues = EMPTY_JOB_FILTERS,
): JobFilterValues {
  return {
    keywords: filters.keywords ?? fallback.keywords,
    location: filters.location ?? fallback.location,
    postedWithin:
      (filters.postedWithin as PostedWithin | undefined) ??
      fallback.postedWithin,
    contractType: filters.contractType ?? fallback.contractType,
    remote: (filters.remote as "" | Remote | undefined) ?? fallback.remote,
    experienceLevel: filters.experienceLevel ?? fallback.experienceLevel,
  };
}

export function JobFilterFields({
  idPrefix,
  values,
  onChange,
}: {
  idPrefix: string;
  values: JobFilterValues;
  onChange: (next: JobFilterValues) => void;
}) {
  const t = useTranslations("jobFilters");
  const tIng = useTranslations("ingestion");

  function set<K extends keyof JobFilterValues>(
    key: K,
    value: JobFilterValues[K],
  ) {
    onChange({ ...values, [key]: value });
  }

  const fieldId = (name: string) => `${idPrefix}-${name}`;

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId("keywords")}>{t("keywordsLabel")}</Label>
        <Input
          id={fieldId("keywords")}
          type="text"
          value={values.keywords}
          onChange={(e) => set("keywords", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId("location")}>{t("locationLabel")}</Label>
        <Input
          id={fieldId("location")}
          type="text"
          value={values.location}
          onChange={(e) => set("location", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId("posted-within")}>
          {t("postedWithinLabel")}
        </Label>
        <select
          id={fieldId("posted-within")}
          className={SELECT_CLASS}
          value={values.postedWithin}
          onChange={(e) => set("postedWithin", e.target.value as PostedWithin)}
        >
          {POSTED_WITHIN_VALUES.map((value) => (
            <option key={value} value={value}>
              {tIng(`postedWithin.${value}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId("contract-type")}>
          {t("contractTypeLabel")}
        </Label>
        <Input
          id={fieldId("contract-type")}
          type="text"
          value={values.contractType}
          onChange={(e) => set("contractType", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId("remote")}>{t("remoteLabel")}</Label>
        <select
          id={fieldId("remote")}
          className={SELECT_CLASS}
          value={values.remote}
          onChange={(e) => set("remote", e.target.value as "" | Remote)}
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
        <Label htmlFor={fieldId("experience-level")}>
          {t("experienceLevelLabel")}
        </Label>
        <Input
          id={fieldId("experience-level")}
          type="text"
          value={values.experienceLevel}
          onChange={(e) => set("experienceLevel", e.target.value)}
        />
      </div>
    </>
  );
}
