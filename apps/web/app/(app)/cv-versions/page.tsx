"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";

import {
  useCvVersions,
  useCvVersionMarkdown,
  useCreateCvVersion,
  useConvertCvVersion,
  useSetDefaultCvVersion,
  useReplaceCvVersion,
  firstFile,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
  type CvConversionStatus,
} from "@/hooks/use-cv-versions";
import { useEnumLabel } from "@/lib/enum-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

function conversionBadgeVariant(
  status: CvConversionStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "CONVERTED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "CONVERTING") return "warning";
  return "secondary";
}

/**
 * Read-only panel showing the raw Markdown rendition of one CV version. The
 * query is only mounted (and only fetches) while the panel is open, so the
 * list stays small — `markdownContent` is never inlined in the list response.
 */
function CvMarkdownPreview({ id }: { id: string }) {
  const t = useTranslations("cvVersions");
  const markdown = useCvVersionMarkdown(id, true);

  return (
    <div className="mt-3 border-t pt-3">
      <h3 className="text-sm font-medium">{t("list.markdownHeading")}</h3>
      {markdown.isPending && (
        <p role="status" className="mt-2 text-sm text-muted">
          {t("list.markdownLoading")}
        </p>
      )}
      {markdown.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t("list.markdownError")}
        </p>
      )}
      {markdown.data &&
        (markdown.data.markdownContent ? (
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-xs">
            {markdown.data.markdownContent}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-muted">{t("list.markdownEmpty")}</p>
        ))}
    </div>
  );
}

/**
 * Inline "Replace" form for one row (issue #74). Pre-filled with the row's
 * current label (editable); reuses the same file-type/size validation as the
 * upload form above. On success, the old row's `supersededById` points at the
 * new row, so it drops out of `useCvVersions()`'s default (non-superseded)
 * view and this form's parent unmounts it.
 */
function CvReplaceForm({
  cv,
  onDone,
}: {
  cv: { id: string; label: string };
  onDone: () => void;
}) {
  const t = useTranslations("cvVersions");
  const replace = useReplaceCvVersion();

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
    defaultValues: { label: cv.label },
  });

  const onSubmit = handleSubmit((values) => {
    const file = firstFile(values.file);
    if (!file) return;
    replace.mutate(
      { id: cv.id, label: values.label.trim(), file },
      { onSuccess: onDone },
    );
  });

  return (
    <form
      className="mt-3 flex flex-col gap-4 border-t pt-3"
      onSubmit={onSubmit}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`replace-label-${cv.id}`}>
          {t("list.replaceLabelLabel")}
        </Label>
        <Input
          id={`replace-label-${cv.id}`}
          type="text"
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
        <Label htmlFor={`replace-file-${cv.id}`}>
          {t("list.replaceFileLabel")}
        </Label>
        <Input
          id={`replace-file-${cv.id}`}
          type="file"
          accept={CV_FILE_ACCEPT}
          aria-invalid={errors.file ? true : undefined}
          {...register("file")}
        />
        {errors.file && (
          <p role="alert" className="text-sm text-destructive">
            {errors.file.message as string}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={replace.isPending}>
          {replace.isPending ? t("list.replacing") : t("list.replaceSubmit")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          {t("list.cancelReplace")}
        </Button>
      </div>

      {replace.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("list.replaceError")}
        </p>
      )}
    </form>
  );
}

export default function CvVersionsPage() {
  const t = useTranslations("cvVersions");
  const conversionStatusLabel = useEnumLabel("cvConversionStatus");

  const list = useCvVersions();
  const create = useCreateCvVersion();
  const convert = useConvertCvVersion();
  const setDefault = useSetDefaultCvVersion();
  const [openMarkdownId, setOpenMarkdownId] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);

  // Default view excludes superseded CVVersions (issue #74) — showing them is
  // a separate, off-by-default filter (issue #75), not built here.
  const visibleCvVersions = list.data?.filter((cv) => cv.supersededById === null);

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
    reset,
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
      { onSuccess: () => reset({ label: "" }) },
    );
  });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-10 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>

      <section className="flex flex-col gap-4">
        <h2 className="font-serif text-xl font-semibold">
          {t("form.heading")}
        </h2>

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
              {create.isSuccess && (
                <p role="status" className="text-sm text-success">
                  {t("form.success")}
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
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-serif text-xl font-semibold">
          {t("list.heading")}
        </h2>

        {list.isPending && (
          <div
            role="status"
            aria-label={t("list.loading")}
            className="flex flex-col gap-3"
          >
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}

        {list.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("list.loadError")}
          </p>
        )}

        {visibleCvVersions && visibleCvVersions.length === 0 && (
          <p className="text-sm text-muted">{t("list.empty")}</p>
        )}

        {setDefault.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("list.setDefaultError")}
          </p>
        )}
        {setDefault.isSuccess && (
          <p role="status" className="text-sm text-success">
            {t("list.setDefaultSuccess")}
          </p>
        )}
        {convert.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("list.convertError")}
          </p>
        )}

        {visibleCvVersions && visibleCvVersions.length > 0 && (
          <ul className="flex flex-col gap-3">
            {visibleCvVersions.map((cv) => (
              <li key={cv.id}>
                <Card className="py-0">
                  <CardContent className="flex flex-col py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{cv.label}</span>
                        <span className="truncate text-xs text-muted">
                          {cv.fileName} · {cv.fileType}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <Badge
                          variant={conversionBadgeVariant(cv.conversionStatus)}
                        >
                          {conversionStatusLabel(cv.conversionStatus)}
                        </Badge>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setOpenMarkdownId((current) =>
                              current === cv.id ? null : cv.id,
                            )
                          }
                        >
                          {openMarkdownId === cv.id
                            ? t("list.hideMarkdown")
                            : t("list.viewMarkdown")}
                        </Button>
                        {(() => {
                          const busy =
                            cv.conversionStatus === "CONVERTING" ||
                            (convert.isPending && convert.variables === cv.id);
                          return (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => convert.mutate(cv.id)}
                              disabled={busy}
                            >
                              {busy
                                ? t("list.converting")
                                : cv.conversionStatus === "CONVERTED"
                                  ? t("list.reconvert")
                                  : t("list.convert")}
                            </Button>
                          );
                        })()}
                        {cv.isDefault ? (
                          <Badge variant="outline">{t("list.default")}</Badge>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setDefault.mutate(cv.id)}
                            disabled={
                              setDefault.isPending &&
                              setDefault.variables === cv.id
                            }
                          >
                            {setDefault.isPending &&
                            setDefault.variables === cv.id
                              ? t("list.settingDefault")
                              : t("list.setDefault")}
                          </Button>
                        )}
                        {replacingId !== cv.id && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setReplacingId(cv.id)}
                          >
                            {t("list.replace")}
                          </Button>
                        )}
                      </div>
                    </div>
                    {cv.conversionStatus === "FAILED" && (
                      <p role="alert" className="mt-2 text-sm text-destructive">
                        {t("list.conversionFailed")}
                        {cv.conversionError ? ` ${cv.conversionError}` : ""}
                      </p>
                    )}
                    {openMarkdownId === cv.id && (
                      <CvMarkdownPreview id={cv.id} />
                    )}
                    {replacingId === cv.id && (
                      <CvReplaceForm
                        cv={cv}
                        onDone={() => setReplacingId(null)}
                      />
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
