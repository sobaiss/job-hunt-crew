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
 * non-superseded CVs (a replaced CV, per issue #74, is left off entirely — not
 * merely disabled) with their `conversionStatus`; only `CONVERTED` ones are
 * selectable. Owns its own fetch (loading / error states) so callers only wire
 * `value` / `onChange`. Importing a new CV is not this component's job — every
 * caller sends the candidate to `/cv-versions/new` (via the "no CV converted"
 * fallback below, or the CV-versions page itself).
 *
 * With `autoSelectDefault` (the default), the `isDefault` CV is preselected
 * once it's `CONVERTED` and nothing has been chosen yet — an Analysis's
 * Re-run/relaunch pickers rely on this, deliberately falling back to it when
 * the Analysis's own CV is no longer a valid choice. Every screen that starts
 * something new from a blank CV choice — "Analyse one offer", "Analyse
 * several offers", and the Scout create/edit form — passes `false` instead:
 * that action must never silently run against a CV the candidate didn't
 * consciously pick, so nothing is selected until they choose one. (The edit
 * form starts from the Scout's own `cvVersionId`, already non-empty, so this
 * has no effect there — only the create form's blank start is affected.)
 */
export function CvVersionPicker({
  value,
  onChange,
  id = "cv-version",
  autoSelectDefault = true,
}: {
  value: string;
  onChange: (cvVersionId: string) => void;
  id?: string;
  autoSelectDefault?: boolean;
}) {
  const t = useTranslations("cvPicker");
  const statusLabel = useEnumLabel("cvConversionStatus");
  const { data: cvVersions, isPending, isError } = useCvVersions();

  // Preselect the isDefault CONVERTED CV once, while nothing has been chosen
  // yet. Once `value` is set (here or by the user) this backs off.
  useEffect(() => {
    if (!autoSelectDefault || value || !cvVersions) return;
    const preselect = cvVersions.find(
      (cv) => cv.isDefault && cv.conversionStatus === "CONVERTED",
    );
    if (preselect) onChange(preselect.id);
  }, [autoSelectDefault, cvVersions, value, onChange]);

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

  // A superseded CV was replaced (issue #74) — it must never be offered as a
  // choice here, unlike the not-yet-CONVERTED case which is shown disabled.
  const selectableCvVersions = cvVersions.filter(
    (cv) => cv.supersededById === null,
  );

  const hasConverted = selectableCvVersions.some(
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
        {selectableCvVersions.map((cv) => (
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
