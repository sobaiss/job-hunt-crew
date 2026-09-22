"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

import {
  useCvVersions,
  useCvVersionMarkdown,
  useSaveCvVersionMarkdown,
} from "@/hooks/use-cv-versions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

// Issue #186: a CV-version-scoped page to read a CVVersion's Markdown
// rendition as a real formatted document and, from there, hand-edit and save
// it in place (docs/adr/0025, #185's API). Not linked from anywhere yet
// (that's #187) — reachable only by navigating here directly. Metadata comes
// from the already-cached CV-versions list query (find-by-id), content from
// the existing per-CV rendition query — no new read endpoint.

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ ...props }) => <h1 className="text-xl font-semibold" {...props} />,
  h2: ({ ...props }) => <h2 className="mt-4 text-lg font-semibold" {...props} />,
  h3: ({ ...props }) => <h3 className="mt-3 text-base font-semibold" {...props} />,
  p: ({ ...props }) => <p className="mt-2 leading-relaxed" {...props} />,
  ul: ({ ...props }) => <ul className="mt-2 list-disc pl-5" {...props} />,
  ol: ({ ...props }) => <ol className="mt-2 list-decimal pl-5" {...props} />,
  li: ({ ...props }) => <li className="mt-1" {...props} />,
  a: ({ ...props }) => (
    <a className="text-accent underline" target="_blank" rel="noreferrer" {...props} />
  ),
  table: ({ ...props }) => (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ ...props }) => (
    <th className="border border-border bg-muted/30 px-2 py-1 text-left" {...props} />
  ),
  td: ({ ...props }) => <td className="border border-border px-2 py-1" {...props} />,
  hr: ({ ...props }) => <hr className="mt-4 border-border" {...props} />,
};

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
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-8">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  if (!eligible) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("edit.notEligible")}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <Link href="/cv-versions" className="text-sm text-accent underline">
          {t("edit.back")}
        </Link>
        <h1 className="font-serif text-2xl font-semibold">{cv.label}</h1>
      </div>

      {!isEditing && (
        <>
          <div className="rounded-md border border-border bg-white p-6 text-sm text-foreground">
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
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {markdown.data.markdownContent ?? ""}
              </ReactMarkdown>
            )}
          </div>
          <div>
            <Button type="button" onClick={startEditing} disabled={!markdown.data}>
              {t("edit.modify")}
            </Button>
          </div>
        </>
      )}

      {isEditing && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t("edit.instructions")}</p>
          <Textarea
            aria-label={t("edit.textareaLabel")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={20}
            className="font-mono"
          />

          {!confirming && (
            <div className="flex items-center gap-2">
              <Button type="button" disabled={!canSave} onClick={() => setConfirming(true)}>
                {t("edit.save")}
              </Button>
              <Button type="button" variant="outline" onClick={cancelEditing}>
                {t("edit.cancel")}
              </Button>
            </div>
          )}

          {confirming && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">{t("edit.saveConfirm")}</span>
              <Button type="button" disabled={save.isPending} onClick={confirmSave}>
                {t("edit.confirmAction")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending}
                onClick={() => setConfirming(false)}
              >
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
