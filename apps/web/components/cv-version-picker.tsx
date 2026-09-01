"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCvVersions,
  useCreateCvVersion,
  firstFile,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
} from "@/hooks/use-cv-versions";
import { useEnumLabel } from "@/lib/enum-labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
 *
 * With `allowImport` (the "Analyse one offer" screen passes it) the picker also
 * renders an inline CV importer: it reuses the presigned-upload flow, polls the
 * new CV's Conversion, shows a converting / failed state, and — once the import
 * is `CONVERTED` — selects it in the picker. The rest of the screen's form
 * state (the pasted offer URL) is untouched throughout.
 */
export function CvVersionPicker({
  value,
  onChange,
  id = "cv-version",
  allowImport = false,
}: {
  value: string;
  onChange: (cvVersionId: string) => void;
  id?: string;
  allowImport?: boolean;
}) {
  const t = useTranslations("cvPicker");
  const statusLabel = useEnumLabel("cvConversionStatus");
  const {
    data: cvVersions,
    isPending,
    isError,
  } = useCvVersions({ pollWhileConverting: allowImport });

  const create = useCreateCvVersion();
  const [importedId, setImportedId] = useState<string | null>(null);

  const importedCv = importedId
    ? cvVersions?.find((cv) => cv.id === importedId)
    : undefined;
  const importConverted = importedCv?.conversionStatus === "CONVERTED";
  const importFailed = importedCv?.conversionStatus === "FAILED";
  // The list refetch triggered by the upload may not have landed the new row
  // yet — treat that window as "still converting" too.
  const importConverting =
    (importedId != null && create.isSuccess && importedCv == null) ||
    importedCv?.conversionStatus === "PENDING" ||
    importedCv?.conversionStatus === "CONVERTING";

  const importSchema = z.object({
    label: z.string().trim().min(1, t("importLabelRequired")),
    file: z
      .any()
      .refine((v) => firstFile(v) !== undefined, t("importFileRequired"))
      .refine((v) => {
        const f = firstFile(v);
        return !f || f.type in ACCEPTED_CV_CONTENT_TYPES;
      }, t("importFileType"))
      .refine((v) => {
        const f = firstFile(v);
        return !f || f.size <= MAX_CV_SIZE_BYTES;
      }, t("importFileTooLarge")),
  });

  const importForm = useForm<z.infer<typeof importSchema>>({
    resolver: zodResolver(importSchema),
    defaultValues: { label: "" },
  });

  const runImport = importForm.handleSubmit((values) => {
    const file = firstFile(values.file);
    if (!file) return;
    create.mutate(
      { label: values.label.trim(), file },
      {
        onSuccess: (created) => {
          setImportedId(created.cvVersionId);
          importForm.reset({ label: "" });
        },
      },
    );
  });

  // Auto-select while nothing is chosen yet: a freshly imported CV wins once its
  // Conversion lands `CONVERTED`, otherwise the `isDefault` CONVERTED CV. Once
  // `value` is set (here or by the user) this backs off.
  useEffect(() => {
    if (value || !cvVersions) return;
    const imported = importedId
      ? cvVersions.find((cv) => cv.id === importedId)
      : undefined;
    if (imported?.conversionStatus === "CONVERTED") {
      onChange(imported.id);
      return;
    }
    const preselect = cvVersions.find(
      (cv) => cv.isDefault && cv.conversionStatus === "CONVERTED",
    );
    if (preselect) onChange(preselect.id);
  }, [cvVersions, value, importedId, onChange]);

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
    <div className="flex flex-col gap-3">
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
        {!hasConverted && !allowImport && (
          <p className="text-sm text-muted">
            {t("noneConverted")}{" "}
            <Link href="/cv-versions" className="text-accent underline">
              {t("manageLink")}
            </Link>
          </p>
        )}
      </div>

      {allowImport && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          <p className="text-sm font-medium">{t("importHeading")}</p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-import-label`}>{t("importLabelLabel")}</Label>
            <Input
              id={`${id}-import-label`}
              type="text"
              // This importer is not a <form> (it is nested inside the screen's
              // form); stop Enter here from submitting that outer form.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              aria-invalid={
                importForm.formState.errors.label ? true : undefined
              }
              {...importForm.register("label")}
            />
            {importForm.formState.errors.label && (
              <p role="alert" className="text-sm text-destructive">
                {importForm.formState.errors.label.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-import-file`}>{t("importFileLabel")}</Label>
            <Input
              id={`${id}-import-file`}
              type="file"
              accept={CV_FILE_ACCEPT}
              aria-invalid={importForm.formState.errors.file ? true : undefined}
              {...importForm.register("file")}
            />
            <p className="text-xs text-muted">{t("importFileHint")}</p>
            {importForm.formState.errors.file && (
              <p role="alert" className="text-sm text-destructive">
                {importForm.formState.errors.file.message as string}
              </p>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={runImport}
            disabled={create.isPending || importConverting}
          >
            {create.isPending ? t("importing") : t("importSubmit")}
          </Button>

          {importConverting && (
            <p role="status" className="text-sm text-muted">
              {t("importConverting")}
            </p>
          )}
          {importFailed && (
            <p role="alert" className="text-sm text-destructive">
              {t("importFailed")}
            </p>
          )}
          {importConverted && (
            <p role="status" className="text-sm text-success">
              {t("importConverted")}
            </p>
          )}
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("importUploadError")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
