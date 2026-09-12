"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  useAnalysisGeneratedDocuments,
  useCreateGeneratedDocuments,
  useGeneratedDocument,
  useRegenerateGeneratedDocument,
  type GeneratedDocument,
} from "@/hooks/use-generated-documents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BffError } from "@/lib/bff-client";

// "Generate documents" on a completed Analysis (issue #58, Scout slice 6):
// creates a COVER_LETTER + a TAILORED_CV GeneratedDocument and polls each
// until it leaves PENDING/GENERATING, then offers a PDF download rendered
// on demand (services/api/src/api/pdf_render.py). Existing documents survive
// a page reload via `useAnalysisGeneratedDocuments` (GET .../generated-
// documents), which also backs the "Apply" action's readiness check.
// "Regenerate"/"Try again" swap the card to polling the fresh row the API
// returns — the old row is superseded server-side and drops out of the
// analysis's generated-documents list.

function DocumentCard({ id: initialId, title }: { id: string; title: string }) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const [id, setId] = useState(initialId);
  const { data: document } = useGeneratedDocument(id);
  const regenerate = useRegenerateGeneratedDocument(id);

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
                  onSuccess: (data) => setId(data.generatedDocument.id),
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
                <a
                  href={`/api/generated-documents/${id}/pdf`}
                  download
                  className="w-fit text-sm font-medium text-primary underline underline-offset-2"
                >
                  {t("downloadPdf")}
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    regenerate.mutate(undefined, {
                      onSuccess: (data) => setId(data.generatedDocument.id),
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

  const documents = created ?? (existing && existing.length > 0 ? existing : null);
  const coverLetter = documents?.find((d) => d.type === "COVER_LETTER") ?? null;
  const tailoredCv = documents?.find((d) => d.type === "TAILORED_CV") ?? null;

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
        <div className="grid gap-4 sm:grid-cols-2">
          {coverLetter && <DocumentCard id={coverLetter.id} title={t("coverLetter")} />}
          {tailoredCv && <DocumentCard id={tailoredCv.id} title={t("tailoredCv")} />}
        </div>
      )}
    </section>
  );
}
