"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { useCvVersions } from "@/hooks/use-cv-versions";
import { useEnumLabel } from "@/lib/enum-labels";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

// A styled native <select>: mirrors the ingestion form's SELECT_CLASS so the
// forms read as one system, and is trivial to drive with user-event.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The shared CVVersion picker for the matching-flow screens. Lists the caller's
 * CVs with their `conversionStatus`; only `CONVERTED` ones are selectable; the
 * `isDefault` one is preselected once, when it is `CONVERTED` and nothing has
 * been chosen yet. Owns its own fetch (loading / error states) so callers only
 * wire `value` / `onChange`.
 */
export function CvVersionPicker({
  value,
  onChange,
  id = "cv-version",
}: {
  value: string;
  onChange: (cvVersionId: string) => void;
  id?: string;
}) {
  const t = useTranslations("cvPicker");
  const statusLabel = useEnumLabel("cvConversionStatus");
  const { data: cvVersions, isPending, isError } = useCvVersions();

  useEffect(() => {
    if (value || !cvVersions) return;
    const preselect = cvVersions.find(
      (cv) => cv.isDefault && cv.conversionStatus === "CONVERTED",
    );
    if (preselect) onChange(preselect.id);
  }, [cvVersions, value, onChange]);

  if (isPending) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{t("label")}</Label>
        <Skeleton className="h-9 w-full" aria-label={t("loading")} role="status" />
      </div>
    );
  }

  if (isError || !cvVersions) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  const hasConverted = cvVersions.some(
    (cv) => cv.conversionStatus === "CONVERTED",
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("label")}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>
          {t("placeholder")}
        </option>
        {cvVersions.map((cv) => (
          <option
            key={cv.id}
            value={cv.id}
            disabled={cv.conversionStatus !== "CONVERTED"}
          >
            {cv.label} — {statusLabel(cv.conversionStatus)}
          </option>
        ))}
      </select>
      {!hasConverted && (
        <p className="text-sm text-muted">
          {t("noneConverted")}{" "}
          <Link href="/cv-versions" className="text-accent underline">
            {t("manageLink")}
          </Link>
        </p>
      )}
    </div>
  );
}
