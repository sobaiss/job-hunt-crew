"use client";

import { useTranslations } from "next-intl";

import {
  POSTED_WITHIN_VALUES,
  REMOTE_VALUES,
  type PostedWithin,
  type Remote,
  type SiteSearchFilters,
} from "@/hooks/use-ingestion-jobs";
import { useLocationResolution } from "@/hooks/use-location-resolution";
import type { SiteConfig } from "@/hooks/use-site-configs";
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

// The filters a candidate can fill in, in form order, with their label key.
// `experienceLevel` is absent: no site honours it, so it is hidden rather than
// shown under a warning that never varies (docs/adr/0030). Its key stays in
// JobFilterValues so restoring it needs no migration.
const SHOWN_FILTERS = [
  ["keywords", "keywordsLabel"],
  ["location", "locationLabel"],
  ["postedWithin", "postedWithinLabel"],
  ["contractType", "contractTypeLabel"],
  ["remote", "remoteLabel"],
] as const;

type ShownFilter = (typeof SHOWN_FILTERS)[number][0];

function isFilled(values: JobFilterValues, key: keyof JobFilterValues) {
  if (key === "postedWithin") return values.postedWithin !== "any";
  return values[key].trim() !== "";
}

/**
 * Per selected site, the filled filters it will not honour as asked — the
 * FilterSupport statement shown before a run (docs/adr/0030). A value the
 * site treats differently from the rest of its filter (a derogation) is
 * judged on its own, and names the substitute applied when there is one.
 * A location a site only takes resolved is judged by whether it resolves.
 * Renders nothing when every filled filter is SUPPORTED on every site.
 * Also shown on a saved Scout's panel, so a Scout nobody reopens still says
 * which of its filters are not honoured (issue #211).
 */
export function FilterSupportNotice({
  sites,
  values,
}: {
  sites: SiteConfig[];
  values: JobFilterValues;
}) {
  const t = useTranslations("jobFilters");
  const tIng = useTranslations("ingestion");

  // Asked only when some site needs the location resolved (#215).
  const resolution = useLocationResolution(
    values.location,
    sites.some((site) => site.filterSupport?.location?.whenUnresolved),
  );
  const unresolved = resolution === null;

  // The select filters' values have labels; free text is shown as typed.
  const valueLabel = (key: ShownFilter, value: string) =>
    key === "postedWithin" || key === "remote"
      ? tIng(`${key}.${value}` as Parameters<typeof tIng>[0])
      : value;

  const lines = sites.flatMap((site) => {
    const filled = SHOWN_FILTERS.filter(([key]) => isFilled(values, key)).map(
      ([key, labelKey]) => {
        const support = site.filterSupport?.[key];
        const derogation = support?.derogations?.[values[key]];
        // A location the site cannot resolve takes the level it falls to.
        const unresolvedLevel =
          key === "location" && unresolved ? support?.whenUnresolved : null;
        const level = unresolvedLevel ?? (derogation ?? support)?.level;
        return { key, label: t(labelKey), level, derogation, unresolvedLevel };
      },
    );
    const byLevel = (level: "UNSUPPORTED" | "APPROXIMATED") =>
      filled
        .filter(
          (filter) =>
            filter.unresolvedLevel !== "UNSUPPORTED" &&
            !filter.derogation?.substitute &&
            filter.level === level,
        )
        .map(({ label }) => label);
    const line = (
      message: "supportUnsupported" | "supportApproximated",
      filters: string[],
    ) =>
      filters.length
        ? [t(message, { site: site.displayName, filters: filters.join(", ") })]
        : [];
    const substituted = filled.flatMap(({ key, label, derogation }) =>
      derogation?.substitute
        ? [
            t("supportSubstituted", {
              site: site.displayName,
              filter: label,
              value: valueLabel(key, values[key]),
              substitute: valueLabel(key, derogation.substitute),
            }),
          ]
        : [],
    );
    const notResolved = filled.flatMap(({ label, unresolvedLevel }) =>
      // Worded on its own, so the candidate sees which text was not read.
      unresolvedLevel === "UNSUPPORTED"
        ? [
            t("supportUnresolved", {
              site: site.displayName,
              filter: label,
              value: values.location.trim(),
            }),
          ]
        : [],
    );
    return [
      ...notResolved,
      ...line("supportUnsupported", byLevel("UNSUPPORTED")),
      ...line("supportApproximated", byLevel("APPROXIMATED")),
      ...substituted,
    ];
  });

  if (lines.length === 0) return null;
  return (
    <div
      role="note"
      className="flex flex-col gap-1 rounded-md border border-border bg-muted/10 p-3 text-sm"
    >
      <p className="font-medium">{t("supportHeading")}</p>
      <ul className="list-disc pl-5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function JobFilterFields({
  idPrefix,
  values,
  onChange,
  sites = [],
}: {
  idPrefix: string;
  values: JobFilterValues;
  onChange: (next: JobFilterValues) => void;
  /** The selected sites, whose FilterSupport the fields warn about. */
  sites?: SiteConfig[];
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

      <FilterSupportNotice sites={sites} values={values} />
    </>
  );
}
