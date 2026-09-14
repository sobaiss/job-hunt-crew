"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  useAnalysisGeneratedDocuments,
  useCreateGeneratedDocuments,
  useGeneratedDocument,
  useRegenerateGeneratedDocument,
  GENERATED_DOCUMENT_FORMATS,
  type GeneratedDocument,
  type GeneratedDocumentFormat,
} from "@/hooks/use-generated-documents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BffError } from "@/lib/bff-client";

// "Generate documents" on a completed Analysis (issue #58, Scout slice 6):
// creates a COVER_LETTER + a TAILORED_CV GeneratedDocument and polls each
// until it leaves PENDING/GENERATING, then offers a download — in any of
// GENERATED_DOCUMENT_FORMATS, rendered on demand (issue #95, see
// services/api/src/api/document_render.py) — via each card's own format
// picker, defaulting to PDF. Existing documents survive a page reload via
// `useAnalysisGeneratedDocuments` (GET .../generated-documents), which also
// backs the "Apply" action's readiness check. "Regenerate"/"Try again" swap
// the card to polling the fresh row the API returns — the old row is
// superseded server-side and drops out of the analysis's generated-documents
// list.

// A styled native <select>: mirrors cv-version-picker.tsx's SELECT_CLASS so
// the two read as one system, and is trivial to drive with user-event.
const SELECT_CLASS =
  "flex h-8 rounded-md border border-border bg-background px-2 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function FormatSelect({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: GeneratedDocumentFormat;
  onChange: (format: GeneratedDocumentFormat) => void;
  label: string;
}) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  return (
    <select
      id={id}
      aria-label={label}
      className={SELECT_CLASS}
      value={value}
      onChange={(event) => onChange(event.target.value as GeneratedDocumentFormat)}
    >
      {GENERATED_DOCUMENT_FORMATS.map((format) => (
        <option key={format} value={format}>
          {t(`format.${format}`)}
        </option>
      ))}
    </select>
  );
}

function DocumentCard({
  id: initialId,
  title,
  format,
  onFormatChange,
  onIdChange,
}: {
  id: string;
  title: string;
  format: GeneratedDocumentFormat;
  onFormatChange: (format: GeneratedDocumentFormat) => void;
  onIdChange: (id: string) => void;
}) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const [id, setId] = useState(initialId);
  const { data: document } = useGeneratedDocument(id);
  const regenerate = useRegenerateGeneratedDocument(id);

  function handleRegenerated(newId: string) {
    setId(newId);
    onIdChange(newId);
  }

  const regenerateErrorMessage =
    regenerate.error instanceof BffError && regenerate.error.status === 429
      ? t("regenerateCapReached")
      : t("regenerateError");

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {!document || document.status === "PENDING" || document.status === "GENERATING" ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="text-sm text-muted">{t("pending")}</p>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : document.status === "FAILED" ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              {document.errorMessage || t("failed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                regenerate.mutate(undefined, {
                  onSuccess: (data) => handleRegenerated(data.generatedDocument.id),
                })
              }
              disabled={regenerate.isPending}
              className="w-fit"
            >
              {t("retry")}
            </Button>
          </>
        ) : (
          <>
            <pre className="whitespace-pre-wrap text-sm text-foreground">
              {document.markdownContent}
            </pre>
            {document.status === "READY" && (
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <FormatSelect
                    id={`${id}-format`}
                    value={format}
                    onChange={onFormatChange}
                    label={t("formatLabel", { title })}
                  />
                  <a
                    href={`/api/generated-documents/${id}/download?format=${format}`}
                    download
                    className="w-fit text-sm font-medium text-primary underline underline-offset-2"
                  >
                    {t("download")}
                  </a>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    regenerate.mutate(undefined, {
                      onSuccess: (data) => handleRegenerated(data.generatedDocument.id),
                    })
                  }
                  disabled={regenerate.isPending}
                >
                  {t("regenerate")}
                </Button>
              </div>
            )}
          </>
        )}
        {regenerate.isError && (
          <p role="alert" className="text-sm text-destructive">
            {regenerateErrorMessage}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function GeneratedDocumentsPanel({ analysisId }: { analysisId: string }) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const create = useCreateGeneratedDocuments(analysisId);
  const { data: existing } = useAnalysisGeneratedDocuments(analysisId);
  const [created, setCreated] = useState<GeneratedDocument[] | null>(null);
  const [coverLetterId, setCoverLetterId] = useState<string | null>(null);
  const [tailoredCvId, setTailoredCvId] = useState<string | null>(null);
  // Each card owns its own format choice; lifted here (rather than into
  // DocumentCard's own local state) purely so downloadBoth can read both at
  // once — mirrors the onIdChange prop pattern used for the id itself.
  const [coverLetterFormat, setCoverLetterFormat] = useState<GeneratedDocumentFormat>("pdf");
  const [tailoredCvFormat, setTailoredCvFormat] = useState<GeneratedDocumentFormat>("pdf");

  const documents = created ?? (existing && existing.length > 0 ? existing : null);
  const coverLetter = documents?.find((d) => d.type === "COVER_LETTER") ?? null;
  const tailoredCv = documents?.find((d) => d.type === "TAILORED_CV") ?? null;
  const activeCoverLetterId = coverLetterId ?? coverLetter?.id ?? null;
  const activeTailoredCvId = tailoredCvId ?? tailoredCv?.id ?? null;

  const { data: coverLetterDoc } = useGeneratedDocument(activeCoverLetterId);
  const { data: tailoredCvDoc } = useGeneratedDocument(activeTailoredCvId);
  const bothReady = coverLetterDoc?.status === "READY" && tailoredCvDoc?.status === "READY";

  function downloadBoth() {
    if (!activeCoverLetterId || !activeTailoredCvId) return;
    window.open(
      `/api/generated-documents/${activeCoverLetterId}/download?format=${coverLetterFormat}`,
      "_blank",
      "noopener,noreferrer",
    );
    window.open(
      `/api/generated-documents/${activeTailoredCvId}/download?format=${tailoredCvFormat}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted">{t("heading")}</h2>

      {!documents && (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (data) => setCreated(data.generatedDocuments),
            })
          }
          disabled={create.isPending}
          className="w-fit"
        >
          {t("generate")}
        </Button>
      )}
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("generateError")}
        </p>
      )}

      {documents && (
        <>
          {bothReady && (
            <Button variant="outline" size="sm" onClick={downloadBoth} className="w-fit">
              {t("downloadBoth")}
            </Button>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {coverLetter && (
              <DocumentCard
                id={coverLetter.id}
                title={t("coverLetter")}
                format={coverLetterFormat}
                onFormatChange={setCoverLetterFormat}
                onIdChange={setCoverLetterId}
              />
            )}
            {tailoredCv && (
              <DocumentCard
                id={tailoredCv.id}
                title={t("tailoredCv")}
                format={tailoredCvFormat}
                onFormatChange={setTailoredCvFormat}
                onIdChange={setTailoredCvId}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
