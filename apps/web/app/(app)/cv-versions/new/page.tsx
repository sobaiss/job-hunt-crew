"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCreateCvVersion,
  firstFile,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
} from "@/hooks/use-cv-versions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function NewCvVersionPage() {
  const t = useTranslations("cvVersions");
  const router = useRouter();
  const create = useCreateCvVersion();

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
      { onSuccess: () => router.replace("/cv-versions") },
    );
  });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <h1 className="font-serif text-2xl font-semibold">
        {t("form.heading")}
      </h1>

      <Card>
        <CardContent className="py-6">
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
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

            <Button
              type="submit"
              disabled={create.isPending}
              className="self-start"
            >
              {create.isPending ? t("form.uploading") : t("form.submit")}
            </Button>

            {create.isPending && (
              <p role="status" className="text-sm text-muted">
                {t("form.uploading")}
              </p>
            )}
            {create.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t("form.error")}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
