"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { useAnalysisGeneratedDocuments } from "@/hooks/use-generated-documents";
import { useMarkAsApplied } from "@/hooks/use-applications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// The two actions a completed Analysis offers (issue #59, Scout slice 7,
// full composition landed as a follow-up once #58's PDF endpoint existed):
// - "Apply": opens the offer's posting in a new tab, downloads both READY
//   generated documents, and records the Application as APPLIED — all in
//   one click. Only enabled once both documents are READY.
// - "Mark as applied": records the Application at APPLIED without
//   generating or downloading documents (e.g. the Candidate applied
//   directly on the site). Always available.
// Undo isn't a separate control here — the linked Application detail page's
// status control can move the Application back to any prior status.
export function ApplicationAction({
  analysisId,
  sourceUrl,
}: {
  analysisId: string;
  sourceUrl: string;
}) {
  const t = useTranslations("analyses.detail.application");
  const markAsApplied = useMarkAsApplied();
  const { data: documents } = useAnalysisGeneratedDocuments(analysisId);

  const readyDocumentIds = (documents ?? [])
    .filter((doc) => doc.status === "READY")
    .map((doc) => doc.id);
  const bothDocumentsReady = (documents ?? []).length === 2 && readyDocumentIds.length === 2;

  if (markAsApplied.data) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="success">{t("applied")}</Badge>
        <Link
          href={`/applications/${markAsApplied.data.application.id}`}
          className="text-accent hover:underline"
        >
          {t("viewApplication")}
        </Link>
      </div>
    );
  }

  function apply() {
    window.open(sourceUrl, "_blank", "noopener,noreferrer");
    for (const id of readyDocumentIds) {
      window.open(`/api/generated-documents/${id}/pdf`, "_blank", "noopener,noreferrer");
    }
    markAsApplied.mutate(analysisId);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="w-fit"
          onClick={apply}
          disabled={!bothDocumentsReady || markAsApplied.isPending}
        >
          {t("apply")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => markAsApplied.mutate(analysisId)}
          disabled={markAsApplied.isPending}
        >
          {t("markApplied")}
        </Button>
      </div>
      {markAsApplied.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("markAppliedError")}
        </p>
      )}
    </div>
  );
}
