"use client";

import type { RefObject } from "react";
import { useTranslations } from "next-intl";
import type { UseMutationResult } from "@tanstack/react-query";

import {
  useCvVersionMarkdown,
  type CvConversionStatus,
  type CvVersion,
} from "@/hooks/use-cv-versions";
import { conversionBadgeVariant, formatFileSize } from "@/lib/cv-versions-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
// Reconvertir/Définir par défaut using the same mutations already wired on
// the table row — Remplacer stays on the row for now (moves here in #82).

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
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-xs">
            {markdown.data.markdownContent}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-muted">{t("list.markdownEmpty")}</p>
        ))}
    </div>
  );
}

export function CvVersionPanel({
  cv,
  replacedByLabel,
  open,
  onOpenChange,
  returnFocusRef,
  conversionStatusLabel,
  convert,
  setDefault,
}: {
  cv: CvVersion | null;
  replacedByLabel: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row that opened this panel — focused again on close, since Radix's
   *  own default only restores focus to a `SheetTrigger` and this panel is
   *  opened programmatically from a table row instead. */
  returnFocusRef: RefObject<HTMLElement | null>;
  conversionStatusLabel: (value: CvConversionStatus) => string;
  convert: UseMutationResult<{ conversionStatus: CvConversionStatus }, Error, string>;
  setDefault: UseMutationResult<{ cvVersion: CvVersion }, Error, string>;
}) {
  const t = useTranslations("cvVersions");

  const busy =
    cv !== null &&
    (cv.conversionStatus === "CONVERTING" ||
      (convert.isPending && convert.variables === cv.id));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
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
                disabled={busy}
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
                    setDefault.isPending && setDefault.variables === cv.id
                  }
                >
                  {setDefault.isPending && setDefault.variables === cv.id
                    ? t("list.settingDefault")
                    : t("list.setDefault")}
                </Button>
              )}
            </div>

            <CvMarkdownPreview id={cv.id} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
