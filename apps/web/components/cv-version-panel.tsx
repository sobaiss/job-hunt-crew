"use client";

import { type RefObject, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";
import type { UseMutationResult } from "@tanstack/react-query";

import {
  useCvVersionMarkdown,
  firstFile,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
  type CreateCvVersionResponse,
  type CvConversionStatus,
  type CvVersion,
} from "@/hooks/use-cv-versions";
import { conversionBadgeVariant, formatFileSize } from "@/lib/cv-versions-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// The right-hand slide-over opened from a CV-versions table row (issue #81),
// mirroring the `Sheet`-based pattern `AnalysisQuickView` already uses. Shows
// the CVVersion's Markdown rendition (fetched only while open, via the same
// on-demand `useCvVersionMarkdown` query) plus its full info, and exposes
// Reconvertir/Définir par défaut/Remplacer (issue #82) using the same
// mutations already wired at the page level, plus a Modifier entry point
// (issue #187) linking to the edit page (#186) for a non-superseded,
// CONVERTED CV version.

/**
 * Read-only Markdown rendition of one CV version. Only mounted while the
 * panel is open, so `markdownContent` is never fetched for a row that isn't
 * being inspected.
 */
function CvMarkdownPreview({ id }: { id: string }) {
  const t = useTranslations("cvVersions");
  const markdown = useCvVersionMarkdown(id, true);

  return (
    <div className="border-t pt-3">
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
          <>
            <p className="mt-2 text-xs text-muted">
              {t("list.markdownRedactionNote")}
            </p>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-xs">
              {markdown.data.markdownContent}
            </pre>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">{t("list.markdownEmpty")}</p>
        ))}
    </div>
  );
}

/**
 * Inline "Replace" form, relocated from the table row into the panel (issue
 * #82). Pre-filled with the CV's current label (editable); same
 * file-type/size validation as the upload form. On success, `onReplaced`
 * carries both the old (now superseded) id — for the Scout-warning banner —
 * and the newly created id, so the page can switch the panel to it.
 */
function CvReplaceForm({
  cv,
  replace,
  disabled,
  onReplaced,
  onCancel,
}: {
  cv: { id: string; label: string };
  replace: UseMutationResult<
    CreateCvVersionResponse,
    Error,
    { id: string; label: string; file: File }
  >;
  /** Forces both buttons off regardless of `replace`'s own state — set while
   *  a delete is in flight, so every control in the panel goes quiet at once
   *  rather than just the ones the delete itself touches. */
  disabled: boolean;
  onReplaced: (oldId: string, newId: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("cvVersions");

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
      { onSuccess: (data) => onReplaced(cv.id, data.cvVersionId) },
    );
  });

  return (
    <form
      className="flex flex-col gap-4 border-t pt-3"
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
        <Button type="submit" size="sm" disabled={disabled || replace.isPending}>
          {replace.isPending ? t("list.replacing") : t("list.replaceSubmit")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onCancel}
        >
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

export function CvVersionPanel({
  cv,
  replacedByLabel,
  chainLength,
  open,
  onOpenChange,
  returnFocusRef,
  conversionStatusLabel,
  convert,
  setDefault,
  replace,
  deleteCv,
  onReplaced,
  onDeleted,
}: {
  cv: CvVersion | null;
  replacedByLabel: string | null;
  /** How many CVVersion rows make up this CV (docs/adr/0027) — itself plus
   *  every earlier, now-superseded version. Deleting removes all of them at
   *  once, so the confirmation names this count. */
  chainLength: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row that opened this panel — focused again on close, since Radix's
   *  own default only restores focus to a `SheetTrigger` and this panel is
   *  opened programmatically from a table row instead. */
  returnFocusRef: RefObject<HTMLElement | null>;
  conversionStatusLabel: (value: CvConversionStatus) => string;
  convert: UseMutationResult<{ conversionStatus: CvConversionStatus }, Error, string>;
  setDefault: UseMutationResult<{ cvVersion: CvVersion }, Error, string>;
  replace: UseMutationResult<
    CreateCvVersionResponse,
    Error,
    { id: string; label: string; file: File }
  >;
  deleteCv: UseMutationResult<void, Error, string>;
  /** Called after a successful Replace with (oldId, newId) — the page uses
   *  oldId for the Scout-warning banner and switches the panel to newId. */
  onReplaced: (oldId: string, newId: string) => void;
  /** Called after a successful delete, once the panel has already closed
   *  itself the same way its own close button would — the page's job is
   *  just to refetch the list, the same "Actualiser" already does. */
  onDeleted: () => void;
}) {
  const t = useTranslations("cvVersions");
  const [isReplacing, setIsReplacing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  // While the delete request is in flight, every other action in the panel
  // goes quiet too — there's no row left to act on the moment it succeeds,
  // and nothing here is worth racing against a delete that's about to
  // remove this whole CV out from under it. Kept separate from `busy` below:
  // it should disable the Convert/Reconvert button same as a real
  // Conversion would, but must not relabel it "Converting…" — nothing is
  // converting.
  const deleting = deleteCv.isPending;

  const busy =
    cv !== null &&
    (cv.conversionStatus === "CONVERTING" ||
      (convert.isPending && convert.variables === cv.id));

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setIsReplacing(false);
      setIsConfirmingDelete(false);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-6xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        {!cv && open && (
          <p role="status" className="text-sm text-muted">
            {t("panel.loading")}
          </p>
        )}

        {cv && (
          <>
            <SheetHeader>
              <SheetTitle>{cv.label}</SheetTitle>
            </SheetHeader>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">{t("list.columns.file")}</dt>
              <dd>
                {cv.fileName} · {cv.fileType}
              </dd>
              <dt className="text-muted">{t("list.columns.size")}</dt>
              <dd>{formatFileSize(cv.fileSizeBytes)}</dd>
              <dt className="text-muted">{t("list.columns.uploaded")}</dt>
              <dd>{new Date(cv.createdAt).toLocaleDateString()}</dd>
              <dt className="text-muted">{t("panel.updated")}</dt>
              <dd>{new Date(cv.updatedAt).toLocaleDateString()}</dd>
              <dt className="text-muted">{t("list.columns.status")}</dt>
              <dd>
                <Badge variant={conversionBadgeVariant(cv.conversionStatus)}>
                  {conversionStatusLabel(cv.conversionStatus)}
                </Badge>
              </dd>
              <dt className="text-muted">{t("list.columns.default")}</dt>
              <dd>
                {cv.isDefault ? (
                  <Badge variant="outline">{t("list.default")}</Badge>
                ) : cv.supersededById ? (
                  <span className="text-xs text-muted">
                    {t("list.replacedBy", { label: replacedByLabel ?? "" })}
                  </span>
                ) : (
                  "—"
                )}
              </dd>
            </dl>

            {cv.conversionStatus === "FAILED" && (
              <p role="alert" className="text-sm text-destructive">
                {t("list.conversionFailed")}
                {cv.conversionError ? ` ${cv.conversionError}` : ""}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => convert.mutate(cv.id)}
                disabled={busy || deleting}
              >
                {busy
                  ? t("list.converting")
                  : cv.conversionStatus === "CONVERTED"
                    ? t("list.reconvert")
                    : t("list.convert")}
              </Button>
              {!cv.isDefault && !cv.supersededById && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDefault.mutate(cv.id)}
                  disabled={
                    deleting ||
                    (setDefault.isPending && setDefault.variables === cv.id)
                  }
                >
                  {setDefault.isPending && setDefault.variables === cv.id
                    ? t("list.settingDefault")
                    : t("list.setDefault")}
                </Button>
              )}
              {!isReplacing && !cv.supersededById && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => setIsReplacing(true)}
                >
                  {t("list.replace")}
                </Button>
              )}
              {!cv.supersededById &&
                cv.conversionStatus === "CONVERTED" &&
                (busy || deleting ? (
                  <Button type="button" size="sm" variant="outline" disabled>
                    {t("edit.modify")}
                  </Button>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/cv-versions/${cv.id}/edit`}>
                      {t("edit.modify")}
                    </Link>
                  </Button>
                ))}
              {!cv.supersededById && !isConfirmingDelete && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => setIsConfirmingDelete(true)}
                >
                  {t("list.delete")}
                </Button>
              )}
            </div>

            {isConfirmingDelete && (
              <div
                role="alert"
                className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm text-muted">
                  {chainLength > 1
                    ? t("list.deleteConfirmChain", { count: chainLength - 1 })
                    : t("list.deleteConfirmSingle")}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={deleting}
                    onClick={() =>
                      deleteCv.mutate(cv.id, {
                        // Closes the same way its own close button would
                        // (resetting isReplacing/isConfirmingDelete too),
                        // rather than lingering on a row that no longer
                        // exists; the page then refetches the list, the
                        // same action "Actualiser" already performs.
                        onSuccess: () => {
                          handleOpenChange(false);
                          onDeleted();
                        },
                      })
                    }
                  >
                    {deleting ? t("list.deleting") : t("edit.confirmAction")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={deleting}
                    onClick={() => setIsConfirmingDelete(false)}
                  >
                    {t("edit.cancelAction")}
                  </Button>
                </div>
              </div>
            )}

            {deleteCv.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t("list.deleteError")}
              </p>
            )}

            {isReplacing && (
              <CvReplaceForm
                cv={cv}
                replace={replace}
                disabled={deleting}
                onReplaced={(oldId, newId) => {
                  setIsReplacing(false);
                  onReplaced(oldId, newId);
                }}
                onCancel={() => setIsReplacing(false)}
              />
            )}

            <CvMarkdownPreview id={cv.id} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
