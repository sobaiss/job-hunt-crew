"use client";

import { useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useConvertCvVersion,
  useCreateCvVersion,
  useCvVersionConversion,
  useCvVersions,
  useReplaceCvVersion,
  useSetDefaultCvVersion,
  apiErrorDetail,
  discardCvVersion,
  firstFile,
  CvStoreError,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
} from "@/hooks/use-cv-versions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CvMarkdownContent } from "@/components/cv-markdown-content";
import { cn } from "@/lib/utils";

// The Import screen (issue #194, apps/web/CONTEXT.md → Import): the whole act
// of adding a CV, in place — create the CVVersion, PUT the bytes, then start
// the Conversion (after the PUT, never before: docs/adr/0028) and poll its
// rendition until it is terminal. On success the CV is rendered as HTML in
// the same paper frame the skeleton held, so there is no layout jump.
// The two halves fail apart (issue #195): storing the CV failed means there
// is no usable file, so the offer is to retry the upload and the half-created
// row is discarded on close; converting it failed means the file is stored
// and the row is legitimate, so the offer is to retry the Conversion or
// replace the file, and nothing is deleted. Resume and wait caps are #196.

/** The white "paper" frame the CV panel already renders a CV in. */
const PAPER_CLASS =
  "rounded-md border border-border bg-white p-8 text-sm text-foreground shadow-sm";

function ImportSteps({ converting }: { converting: boolean }) {
  const t = useTranslations("cvVersions.import");
  const steps = [
    { label: t("step1"), done: converting, active: !converting },
    { label: t("step2"), done: false, active: converting },
    { label: t("step3"), done: false, active: false },
  ];

  return (
    <ol aria-label={t("progressLabel")} className="flex flex-col gap-3">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 flex-none items-center justify-center rounded-full border text-xs",
              step.done
                ? "border-success bg-success text-white"
                : step.active
                  ? "border-foreground text-foreground"
                  : "border-border text-muted",
            )}
          >
            {step.done ? <Check className="size-3" /> : i + 1}
          </span>
          <span
            className={cn(
              "text-sm",
              step.active ? "font-medium" : "text-muted",
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Success actions: finish, edit, and set-as-default unless it already is. */
function ImportedActions({ cvVersionId }: { cvVersionId: string }) {
  const t = useTranslations("cvVersions");
  const cvVersions = useCvVersions();
  const setDefault = useSetDefaultCvVersion();
  const imported = cvVersions.data?.find((cv) => cv.id === cvVersionId);

  return (
    <div className="flex flex-wrap gap-3">
      <Button asChild>
        <Link href="/cv-versions">{t("import.finish")}</Link>
      </Button>
      <Button asChild variant="outline">
        <Link href={`/cv-versions/${cvVersionId}/edit`}>
          {t("import.edit")}
        </Link>
      </Button>
      {imported && !imported.isDefault && (
        <Button
          type="button"
          variant="outline"
          disabled={setDefault.isPending}
          onClick={() => setDefault.mutate(cvVersionId)}
        >
          {setDefault.isPending
            ? t("list.settingDefault")
            : t("list.setDefault")}
        </Button>
      )}
    </div>
  );
}

/** A failure sentence, with the raw cause (when there is one) underneath. */
function ImportFailure({
  message,
  detail,
  children,
}: {
  message: string;
  detail: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-md border border-destructive/40 bg-destructive/10 p-4">
      <div role="alert" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-destructive">{message}</p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** Storing the CV failed: say which of the three causes, offer a retry. */
function StoringFailed({
  error,
  retrying,
  onRetry,
}: {
  error: CvStoreError;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("cvVersions.import");
  return (
    <ImportFailure message={t(`failure.${error.reason}`)} detail={error.detail}>
      <Button type="button" disabled={retrying} onClick={onRetry}>
        {t("retryImport")}
      </Button>
    </ImportFailure>
  );
}

/**
 * Converting the CV failed: the file is stored, so retry the Conversion on
 * the same CVVersion or replace its file (replace, PUT, then convert, the
 * same order as docs/adr/0028).
 */
function ConversionFailed({
  detail,
  busy,
  replaceError,
  onRetry,
  onReplace,
}: {
  detail: string | null | undefined;
  busy: boolean;
  replaceError: string | null;
  onRetry: () => void;
  onReplace: (file: File) => void;
}) {
  const t = useTranslations("cvVersions");

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = firstFile(event.target.files);
    event.target.value = "";
    if (file) onReplace(file);
  }

  return (
    <ImportFailure message={t("import.failure.conversion")} detail={detail}>
      <Button type="button" disabled={busy} onClick={onRetry}>
        {t("import.retryConversion")}
      </Button>
      <label
        className={cn(
          buttonVariants({ variant: "outline" }),
          "cursor-pointer",
          busy && "pointer-events-none opacity-50",
        )}
      >
        {busy ? t("import.replacing") : t("import.replaceFile")}
        <input
          type="file"
          className="sr-only"
          accept={CV_FILE_ACCEPT}
          disabled={busy}
          onChange={onFileChange}
        />
      </label>
      {replaceError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {replaceError}
        </p>
      )}
    </ImportFailure>
  );
}

/** Progress, then the imported CV, for one CVVersion whose bytes are stored. */
function ImportProgress({
  cvVersionId,
  converting,
  convertError,
  failureActions,
}: {
  cvVersionId: string | null;
  converting: boolean;
  /** The convert request itself failed, after the bytes were stored. */
  convertError: unknown;
  failureActions: Omit<React.ComponentProps<typeof ConversionFailed>, "detail">;
}) {
  const t = useTranslations("cvVersions");
  const conversion = useCvVersionConversion(converting ? cvVersionId : null);
  const status = conversion.data?.conversionStatus;

  if (convertError || status === "FAILED") {
    const detail = convertError
      ? apiErrorDetail(convertError)
      : conversion.data?.conversionError;
    return <ConversionFailed detail={detail} {...failureActions} />;
  }

  if (status === "CONVERTED" && cvVersionId) {
    return (
      <div className="flex flex-col gap-4">
        <p
          role="status"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <Check aria-hidden="true" className="size-4 text-success" />
          {t("import.success")}
        </p>
        <ImportedActions cvVersionId={cvVersionId} />
        <p className="text-xs text-muted">{t("list.markdownRedactionNote")}</p>
        <div className={PAPER_CLASS}>
          <CvMarkdownContent content={conversion.data?.markdownContent ?? ""} />
        </div>
      </div>
    );
  }

  const inConversionStep = cvVersionId !== null;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="py-6">
          <div role="status">
            <ImportSteps converting={inConversionStep} />
          </div>
        </CardContent>
      </Card>
      {inConversionStep && (
        <div
          role="img"
          aria-label={t("import.skeletonLabel")}
          className={cn(PAPER_CLASS, "flex flex-col gap-3")}
        >
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </div>
  );
}

export default function NewCvVersionPage() {
  const t = useTranslations("cvVersions");
  const queryClient = useQueryClient();
  const create = useCreateCvVersion();
  const convert = useConvertCvVersion();
  // The Import screen follows the Conversion itself, see ConversionFailed.
  const replaceFile = useReplaceCvVersion({ startConversion: false });
  // Set once the bytes are stored: the CVVersion this Import follows.
  const [cvVersionId, setCvVersionId] = useState<string | null>(null);
  // What was submitted, kept for a retry or a replace.
  const [submitted, setSubmitted] = useState<{
    label: string;
    file: File;
  } | null>(null);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  const schema = z.object({
    label: z.string().trim().min(1, t("form.labelRequired")),
    file: z
      .any()
      .refine((v) => firstFile(v) !== undefined, t("form.fileRequired"))
      .refine((v) => {
        const f = firstFile(v);
        return !f || f.type in ACCEPTED_CV_CONTENT_TYPES;
      }, t("form.fileType"))
      .refine((v) => {
        const f = firstFile(v);
        return !f || f.size <= MAX_CV_SIZE_BYTES;
      }, t("form.fileTooLarge")),
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { label: "" },
  });

  /** The file first, the Conversion second (docs/adr/0028). */
  function startConversion(id: string) {
    // A retry must not read the previous attempt's terminal status.
    queryClient.removeQueries({ queryKey: ["cv-versions", id, "markdown"] });
    convert.mutate(id);
  }

  function store(
    values: { label: string; file: File },
    previous: CvStoreError["created"] = null,
  ) {
    create.mutate(
      { ...values, previous },
      {
        onSuccess: (created) => {
          setCvVersionId(created.cvVersionId);
          startConversion(created.cvVersionId);
        },
      },
    );
  }

  const onSubmit = handleSubmit((values) => {
    const file = firstFile(values.file);
    if (!file) return;
    const next = { label: values.label.trim(), file };
    setSubmitted(next);
    store(next);
  });

  const storeError = create.error instanceof CvStoreError ? create.error : null;

  function retryStore() {
    if (submitted) store(submitted, storeError?.created);
  }

  function replaceConvertedFile(file: File) {
    if (!cvVersionId || !submitted) return;
    if (!(file.type in ACCEPTED_CV_CONTENT_TYPES)) {
      setReplaceError(t("form.fileType"));
      return;
    }
    if (file.size > MAX_CV_SIZE_BYTES) {
      setReplaceError(t("form.fileTooLarge"));
      return;
    }
    setReplaceError(null);
    replaceFile.mutate(
      { id: cvVersionId, label: submitted.label, file },
      {
        onSuccess: (created) => {
          setCvVersionId(created.cvVersionId);
          startConversion(created.cvVersionId);
        },
        onError: () => setReplaceError(t("import.failure.upload")),
      },
    );
  }

  // Only a storing failure leaves a row with no file behind it; only the
  // explicit close discards it — never on unmount or beforeunload, which
  // also fire on a StrictMode double-mount or HMR and guarantee nothing.
  function onClose() {
    if (storeError?.created) discardCvVersion(storeError.created.cvVersionId);
  }

  const importing = create.isPending || cvVersionId !== null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-semibold">
          {t("form.heading")}
        </h1>
        <Button asChild variant="ghost">
          <Link href="/cv-versions" onClick={onClose}>
            {t("import.close")}
          </Link>
        </Button>
      </div>

      {storeError ? (
        <StoringFailed
          error={storeError}
          retrying={create.isPending}
          onRetry={retryStore}
        />
      ) : importing ? (
        <ImportProgress
          cvVersionId={cvVersionId}
          converting={convert.isSuccess}
          convertError={convert.error}
          failureActions={{
            busy: convert.isPending || replaceFile.isPending,
            replaceError,
            onRetry: () => cvVersionId && startConversion(cvVersionId),
            onReplace: replaceConvertedFile,
          }}
        />
      ) : (
        <Card>
          <CardContent className="py-6">
            <form
              className="flex flex-col gap-4"
              onSubmit={onSubmit}
              noValidate
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cv-label">{t("form.labelLabel")}</Label>
                <Input
                  id="cv-label"
                  type="text"
                  placeholder={t("form.labelPlaceholder")}
                  aria-invalid={errors.label ? true : undefined}
                  {...register("label")}
                />
                {errors.label && (
                  <p role="alert" className="text-sm text-destructive">
                    {errors.label.message}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cv-file">{t("form.fileLabel")}</Label>
                <Input
                  id="cv-file"
                  type="file"
                  accept={CV_FILE_ACCEPT}
                  aria-invalid={errors.file ? true : undefined}
                  aria-describedby="cv-file-hint"
                  {...register("file")}
                />
                <p id="cv-file-hint" className="text-xs text-muted">
                  {t("form.fileHint")}
                </p>
                {errors.file && (
                  <p role="alert" className="text-sm text-destructive">
                    {errors.file.message as string}
                  </p>
                )}
              </div>

              <Button type="submit" className="self-start">
                {t("form.submit")}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
