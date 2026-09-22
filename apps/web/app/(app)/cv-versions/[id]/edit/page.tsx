"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, LoaderCircle, Pencil, Save, X } from "lucide-react";

import {
  useCvVersions,
  useCvVersionMarkdown,
  useSaveCvVersionMarkdown,
} from "@/hooks/use-cv-versions";
import { CvMarkdownContent } from "@/components/cv-markdown-content";
import { CvPaper, CV_PAGE_COLUMN_CLASS } from "@/components/cv-paper";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Issue #186: a CV-version-scoped page to read a CVVersion's Markdown
// rendition as a real formatted document and, from there, hand-edit and save
// it in place (docs/adr/0025, #185's API). Not linked from anywhere yet
// (that's #187) — reachable only by navigating here directly. Metadata comes
// from the already-cached CV-versions list query (find-by-id), content from
// the existing per-CV rendition query — no new read endpoint. The rendering
// itself lives in `CvMarkdownContent`, shared with the CV panel's own
// preview so both surfaces render a CV's content identically.

export default function CvVersionEditPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("cvVersions");

  const list = useCvVersions();
  const cv = list.data?.find((row) => row.id === params.id) ?? null;

  // Mirrors services/api's own checks as defense in depth (a stale link, or
  // direct navigation to a superseded/not-yet-converted/nonexistent CV).
  const eligible =
    cv !== null && cv.supersededById === null && cv.conversionStatus === "CONVERTED";

  const markdown = useCvVersionMarkdown(params.id, eligible);
  const save = useSaveCvVersionMarkdown(params.id);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);

  const startEditing = () => {
    setDraft(markdown.data?.markdownContent ?? "");
    setIsEditing(true);
    setConfirming(false);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setConfirming(false);
  };

  const canSave = draft.trim().length > 0;

  const confirmSave = () => {
    save.mutate(draft, {
      onSuccess: () => {
        setIsEditing(false);
        setConfirming(false);
      },
    });
  };

  if (list.isPending) {
    return (
      <main
        className={cn("mx-auto flex w-full flex-col gap-4 p-8", CV_PAGE_COLUMN_CLASS)}
      >
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  if (!eligible) {
    return (
      <main
        className={cn("mx-auto flex w-full flex-col gap-4 p-8", CV_PAGE_COLUMN_CLASS)}
      >
        <p role="alert" className="text-sm text-destructive">
          {t("edit.notEligible")}
        </p>
      </main>
    );
  }

  return (
    <main
      className={cn("mx-auto flex w-full flex-col gap-6 p-8", CV_PAGE_COLUMN_CLASS)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/cv-versions" className="text-sm text-accent underline">
            {t("edit.back")}
          </Link>
          <h1 className="font-serif text-2xl font-semibold">{cv.label}</h1>
        </div>
        {!isEditing && (
          <Button type="button" onClick={startEditing} disabled={!markdown.data}>
            <Pencil aria-hidden="true" />
            {t("edit.modify")}
          </Button>
        )}
      </div>

      {!isEditing && (
        <CvPaper>
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
          {markdown.data && (
            <CvMarkdownContent content={markdown.data.markdownContent ?? ""} />
          )}
        </CvPaper>
      )}

      {isEditing && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t("edit.instructions")}</p>
          <Textarea
            aria-label={t("edit.textareaLabel")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={36}
            className="min-h-[32rem] font-mono text-base"
          />

          {!confirming && (
            <div className="flex items-center gap-2">
              <Button type="button" disabled={!canSave} onClick={() => setConfirming(true)}>
                <Save aria-hidden="true" />
                {t("edit.save")}
              </Button>
              <Button type="button" variant="ghost" onClick={cancelEditing}>
                <X aria-hidden="true" />
                {t("edit.cancel")}
              </Button>
            </div>
          )}

          {confirming && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">{t("edit.saveConfirm")}</span>
              <Button type="button" disabled={save.isPending} onClick={confirmSave}>
                {save.isPending ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {t("edit.confirmAction")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => setConfirming(false)}
              >
                <X aria-hidden="true" />
                {t("edit.cancelAction")}
              </Button>
            </div>
          )}

          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("edit.saveError")}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
