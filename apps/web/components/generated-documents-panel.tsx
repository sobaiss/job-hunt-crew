"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download, LoaderCircle, RefreshCw, RotateCw, Sparkles } from "lucide-react";

import {
  useAnalysisGeneratedDocuments,
  useCreateGeneratedDocuments,
  useGeneratedDocument,
  useRegenerateGeneratedDocument,
  GENERATED_DOCUMENT_FORMATS,
  type GeneratedDocumentFormat,
  type GeneratedDocumentType,
} from "@/hooks/use-generated-documents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { GeneratedDocumentPreview } from "@/components/generated-document-preview";
import { InlineQuotaBanner } from "@/components/inline-quota-banner";
import { BffError } from "@/lib/bff-client";

// The cover letter and the tailored CV, each in a slot of its own (issue #58,
// Scout slice 6; split per type in docs/adr/0031). A slot holds either a
// "Generate" button or the document's card, so a candidate can ask for one
// document without the other — and, having asked for one, can still reach the
// other, which a single all-or-nothing button made impossible once any
// document existed. Each generated document polls until it leaves
// PENDING/GENERATING, then offers a download in any of
// GENERATED_DOCUMENT_FORMATS, rendered on demand (issue #95, see
// services/api/src/api/document_render.py) via its own format picker,
// defaulting to PDF. Existing documents survive a page reload via
// `useAnalysisGeneratedDocuments` (GET .../generated-documents), which also
// backs the "Apply" action's readiness check. "Regenerate"/"Try again" swap
// the slot to the fresh row the API returns — the old row is superseded
// server-side and drops out of the analysis's generated-documents list.

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
  id,
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
  const { data: document } = useGeneratedDocument(id);
  const regenerate = useRegenerateGeneratedDocument(id);

  const regenerateErrorMessage =
    regenerate.error instanceof BffError && regenerate.error.status === 429
      ? t("regenerateCapReached")
      : t("regenerateError");

  return (
    <>
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
                onSuccess: (data) => onIdChange(data.generatedDocument.id),
              })
            }
            disabled={regenerate.isPending}
            className="w-fit"
          >
            {regenerate.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw aria-hidden="true" />
            )}
            {t("retry")}
          </Button>
        </>
      ) : (
        <>
          <GeneratedDocumentPreview markdown={document.markdownContent} />
          {document.status === "READY" && (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FormatSelect
                  id={`${id}-format`}
                  value={format}
                  onChange={onFormatChange}
                  label={t("formatLabel", { title })}
                />
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`/api/generated-documents/${id}/download?format=${format}`}
                    download
                  >
                    <Download aria-hidden="true" />
                    {t("download")}
                  </a>
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  regenerate.mutate(undefined, {
                    onSuccess: (data) => onIdChange(data.generatedDocument.id),
                  })
                }
                disabled={regenerate.isPending}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={regenerate.isPending ? "animate-spin" : undefined}
                />
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
    </>
  );
}

/** One document's slot: its "Generate" button until the row exists, its card
 *  afterwards. Owns its own create mutation so a generation in flight on one
 *  document never disables the other's button. */
function DocumentSlot({
  analysisId,
  type,
  title,
  generateLabel,
  id,
  format,
  onFormatChange,
  onIdChange,
}: {
  analysisId: string;
  type: GeneratedDocumentType;
  title: string;
  generateLabel: string;
  id: string | null;
  format: GeneratedDocumentFormat;
  onFormatChange: (format: GeneratedDocumentFormat) => void;
  onIdChange: (id: string) => void;
}) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const create = useCreateGeneratedDocuments(analysisId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {id === null ? (
          <>
            {/* Accented: with this document missing, asking for it is the
                slot's one live action. */}
            <Button
              size="sm"
              className="w-fit"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(type, {
                  onSuccess: (data) => {
                    const created = data.generatedDocuments[0];
                    if (created) onIdChange(created.id);
                  },
                })
              }
            >
              {create.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
              {generateLabel}
            </Button>
            {create.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t("generateError")}
              </p>
            )}
          </>
        ) : (
          <DocumentCard
            id={id}
            title={title}
            format={format}
            onFormatChange={onFormatChange}
            onIdChange={onIdChange}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function GeneratedDocumentsPanel({ analysisId }: { analysisId: string }) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const { data: existing } = useAnalysisGeneratedDocuments(analysisId);

  // The id each slot is currently showing, once this session has created or
  // regenerated it. Keyed by type rather than held as one list, because the
  // two slots now move independently: generating the tailored CV must not
  // drop the cover letter this panel is already showing.
  const [idByType, setIdByType] = useState<
    Partial<Record<GeneratedDocumentType, string>>
  >({});
  // Each slot owns its own format choice; lifted here (rather than into
  // DocumentCard's own local state) purely so downloadBoth can read both at
  // once — mirrors the onIdChange prop pattern used for the id itself.
  const [coverLetterFormat, setCoverLetterFormat] = useState<GeneratedDocumentFormat>("pdf");
  const [tailoredCvFormat, setTailoredCvFormat] = useState<GeneratedDocumentFormat>("pdf");

  function activeId(type: GeneratedDocumentType): string | null {
    return idByType[type] ?? existing?.find((d) => d.type === type)?.id ?? null;
  }
  const activeCoverLetterId = activeId("COVER_LETTER");
  const activeTailoredCvId = activeId("TAILORED_CV");

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

      {/* While either slot can still spend quota, say what is left. */}
      {(activeCoverLetterId === null || activeTailoredCvId === null) && (
        <InlineQuotaBanner kinds={["documentsDaily"]} />
      )}

      {bothReady && (
        <Button variant="outline" size="sm" onClick={downloadBoth} className="w-fit">
          <Download aria-hidden="true" />
          {t("downloadBoth")}
        </Button>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <DocumentSlot
          analysisId={analysisId}
          type="COVER_LETTER"
          title={t("coverLetter")}
          generateLabel={t("generateCoverLetter")}
          id={activeCoverLetterId}
          format={coverLetterFormat}
          onFormatChange={setCoverLetterFormat}
          onIdChange={(id) => setIdByType((current) => ({ ...current, COVER_LETTER: id }))}
        />
        <DocumentSlot
          analysisId={analysisId}
          type="TAILORED_CV"
          title={t("tailoredCv")}
          generateLabel={t("generateTailoredCv")}
          id={activeTailoredCvId}
          format={tailoredCvFormat}
          onFormatChange={setTailoredCvFormat}
          onIdChange={(id) => setIdByType((current) => ({ ...current, TAILORED_CV: id }))}
        />
      </div>
    </section>
  );
}
