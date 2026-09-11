"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  useCreateGeneratedDocuments,
  useGeneratedDocument,
  type GeneratedDocument,
} from "@/hooks/use-generated-documents";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// "Generate documents" on a completed Analysis (issue #58, Scout slice 6):
// creates a COVER_LETTER + a TAILORED_CV GeneratedDocument and polls each
// until it leaves PENDING/GENERATING. Regenerate and PDF download are not
// wired up yet — read-only Markdown preview only, for this slice.

function DocumentCard({ id, title }: { id: string; title: string }) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const { data: document } = useGeneratedDocument(id);

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
          <p role="alert" className="text-sm text-destructive">
            {document.errorMessage || t("failed")}
          </p>
        ) : (
          <pre className="whitespace-pre-wrap text-sm text-foreground">
            {document.markdownContent}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export function GeneratedDocumentsPanel({ analysisId }: { analysisId: string }) {
  const t = useTranslations("analyses.detail.generatedDocuments");
  const create = useCreateGeneratedDocuments(analysisId);
  const [documents, setDocuments] = useState<GeneratedDocument[] | null>(null);

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
              onSuccess: (data) => setDocuments(data.generatedDocuments),
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
