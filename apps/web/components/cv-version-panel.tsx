"use client";

import { type ReactNode, type RefObject, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";
import {
  FileText,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
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
import { CvMarkdownContent } from "@/components/cv-markdown-content";
import { CvPaper, CV_PANEL_COLUMN_CLASS } from "@/components/cv-paper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// The right-hand slide-over opened from a CV-versions table row (issue #81),
// mirroring the `Sheet`-based pattern `AnalysisQuickView` already uses. Shows
// the CVVersion's Markdown rendition (fetched only while open, via the same
// on-demand `useCvVersionMarkdown` query) plus its full info, and exposes
// Reconvertir/Définir par défaut/Remplacer (issue #82) using the same
// mutations already wired at the page level, plus a Modifier entry point
// (issue #187) linking to the edit page (#186) for a non-superseded,
// CONVERTED CV version. It reads top-down as identity (the label and the
// Conversion's status), then what can be done about it, then the details,
// then the CV itself: the actions come before the properties because the
// panel is opened to act, not to read a grid. The properties live in a
// "Refonte"-style card: the file as itself, then the dates and the default
// state under the same uppercase micro-labels `AnalysisResultView` uses —
// and the rendition itself renders as the same
// real HTML document the edit page shows, via the shared `CvMarkdownContent`,
// instead of a wall of raw Markdown text.

/**
 * One property's label/value pair inside the metadata card, styled to match
 * the uppercase micro-labels used elsewhere in the app's "Refonte" cards
 * (e.g. `AnalysisResultView`'s `SectionLabel`).
 */
function PropertyItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-[0.06em] text-muted uppercase">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * Read-only rendition of one CV version, rendered as a real HTML document —
 * the same `CvMarkdownContent` the edit page uses — inside a "paper" card.
 * Only mounted while the panel is open, so `markdownContent` is never
 * fetched for a row that isn't being inspected.
 */
function CvContentPreview({ id }: { id: string }) {
  const t = useTranslations("cvVersions");
  const markdown = useCvVersionMarkdown(id, true);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-xs font-semibold tracking-[0.06em] text-muted uppercase">
        {t("list.markdownHeading")}
      </h3>
      {markdown.isPending && (
        <p role="status" className="text-sm text-muted">
          {t("list.markdownLoading")}
        </p>
      )}
      {markdown.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("list.markdownError")}
        </p>
      )}
      {markdown.data &&
        (markdown.data.markdownContent ? (
          <>
            <p className="text-xs text-muted">
              {t("list.markdownRedactionNote")}
            </p>
            <CvPaper className="max-h-[36rem] overflow-y-auto">
              <CvMarkdownContent content={markdown.data.markdownContent} />
            </CvPaper>
          </>
        ) : (
          <p className="text-sm text-muted">{t("list.markdownEmpty")}</p>
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
      className="flex flex-col gap-4 border-t border-border pt-5"
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
          {replace.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload aria-hidden="true" />
          )}
          {replace.isPending ? t("list.replacing") : t("list.replaceSubmit")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onCancel}
        >
          <X aria-hidden="true" />
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
        className={cn("w-full gap-6 overflow-y-auto", CV_PANEL_COLUMN_CLASS)}
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
            <SheetHeader className="gap-2 pr-8">
              <SheetTitle className="text-xl">{cv.label}</SheetTitle>
              <Badge
                variant={conversionBadgeVariant(cv.conversionStatus)}
                className="w-fit"
              >
                {conversionStatusLabel(cv.conversionStatus)}
              </Badge>
            </SheetHeader>

            {cv.conversionStatus === "FAILED" && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {t("list.conversionFailed")}
                {cv.conversionError ? ` ${cv.conversionError}` : ""}
              </p>
            )}

            {/* Editing the CV is the one action worth leading with, so it
                carries the accent on its own; the rest stay quiet outlines and
                Delete sits apart, at the far end, coloured as what it is. */}
            <div className="flex flex-wrap items-center gap-2">
              {!cv.supersededById &&
                cv.conversionStatus === "CONVERTED" &&
                (busy || deleting ? (
                  <Button type="button" size="sm" disabled>
                    <Pencil aria-hidden="true" />
                    {t("edit.modify")}
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link href={`/cv-versions/${cv.id}/edit`}>
                      <Pencil aria-hidden="true" />
                      {t("edit.modify")}
                    </Link>
                  </Button>
                ))}
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
                  <Star aria-hidden="true" />
                  {setDefault.isPending && setDefault.variables === cv.id
                    ? t("list.settingDefault")
                    : t("list.setDefault")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => convert.mutate(cv.id)}
                disabled={busy || deleting}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={busy ? "animate-spin" : undefined}
                />
                {busy
                  ? t("list.converting")
                  : cv.conversionStatus === "CONVERTED"
                    ? t("list.reconvert")
                    : t("list.convert")}
              </Button>
              {!isReplacing && !cv.supersededById && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => setIsReplacing(true)}
                >
                  <Upload aria-hidden="true" />
                  {t("list.replace")}
                </Button>
              )}
              {!cv.supersededById && !isConfirmingDelete && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive-ghost"
                  className="ml-auto"
                  disabled={deleting}
                  onClick={() => setIsConfirmingDelete(true)}
                >
                  <Trash2 aria-hidden="true" />
                  {t("list.delete")}
                </Button>
              )}
            </div>

            {/* The file leads, as the object it is — an icon, its name, its
                weight underneath — rather than as the first of five equal
                cells. That leaves exactly three facts to label, which is the
                three columns the grid has, so no ragged last row. */}
            <Card>
              <CardContent className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-10 flex-none items-center justify-center rounded-md border border-border bg-panel text-muted"
                  >
                    <FileText className="size-5" />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {cv.fileName} · {cv.fileType}
                    </span>
                    <span className="text-xs text-muted">
                      {formatFileSize(cv.fileSizeBytes)}
                    </span>
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-4 border-t border-border pt-5 sm:grid-cols-3">
                  <PropertyItem label={t("list.columns.uploaded")}>
                    {new Date(cv.createdAt).toLocaleDateString()}
                  </PropertyItem>
                  <PropertyItem label={t("panel.updated")}>
                    {new Date(cv.updatedAt).toLocaleDateString()}
                  </PropertyItem>
                  <PropertyItem label={t("list.columns.default")}>
                    {cv.isDefault ? (
                      <Badge variant="outline">{t("list.default")}</Badge>
                    ) : cv.supersededById ? (
                      <span className="text-xs text-muted">
                        {t("list.replacedBy", { label: replacedByLabel ?? "" })}
                      </span>
                    ) : (
                      "—"
                    )}
                  </PropertyItem>
                </dl>
              </CardContent>
            </Card>

            {isConfirmingDelete && (
              <div
                role="alert"
                className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
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
                    {deleting ? (
                      <LoaderCircle className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 aria-hidden="true" />
                    )}
                    {deleting ? t("list.deleting") : t("edit.confirmAction")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={deleting}
                    onClick={() => setIsConfirmingDelete(false)}
                  >
                    <X aria-hidden="true" />
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

            <CvContentPreview id={cv.id} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
