"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

import {
  useConvertCvVersion,
  useCreateCvVersion,
  useCvVersionConversion,
  useCvVersions,
  useSetDefaultCvVersion,
  firstFile,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
} from "@/hooks/use-cv-versions";
import { Button } from "@/components/ui/button";
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
// Failure handling is #195; resume and wait caps are #196.

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

/** Progress, then the imported CV, for one CVVersion whose bytes are stored. */
function ImportProgress({
  cvVersionId,
  converting,
  convertFailed,
}: {
  cvVersionId: string | null;
  converting: boolean;
  convertFailed: boolean;
}) {
  const t = useTranslations("cvVersions");
  const conversion = useCvVersionConversion(converting ? cvVersionId : null);
  const status = conversion.data?.conversionStatus;

  if (convertFailed || status === "FAILED") {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        {t("import.conversionFailed")}
      </div>
    );
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
  const create = useCreateCvVersion();
  const convert = useConvertCvVersion();
  // Set once the bytes are stored: the CVVersion this Import follows.
  const [cvVersionId, setCvVersionId] = useState<string | null>(null);

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

  const onSubmit = handleSubmit((values) => {
    const file = firstFile(values.file);
    if (!file) return;
    create.mutate(
      { label: values.label.trim(), file },
      {
        onSuccess: (created) => {
          setCvVersionId(created.cvVersionId);
          convert.mutate(created.cvVersionId);
        },
      },
    );
  });

  const importing = create.isPending || cvVersionId !== null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-semibold">
          {t("form.heading")}
        </h1>
        <Button asChild variant="ghost">
          <Link href="/cv-versions">{t("import.close")}</Link>
        </Button>
      </div>

      {importing ? (
        <ImportProgress
          cvVersionId={cvVersionId}
          converting={convert.isSuccess}
          convertFailed={convert.isError}
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

              {create.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {t("form.error")}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
