"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// "Generate documents" on a relevant find (issue #58, Scout slice 6):
// creates a COVER_LETTER + a TAILORED_CV GeneratedDocument for a completed
// Analysis and polls each until it leaves PENDING/GENERATING. The PDF
// download itself is a plain link to /api/generated-documents/{id}/pdf
// (see generated-documents-panel.tsx), not a hook. Regenerate is not wired
// up yet.

export type GeneratedDocumentType = "COVER_LETTER" | "TAILORED_CV";
export type GeneratedDocumentStatus = "PENDING" | "GENERATING" | "READY" | "FAILED";

export type GeneratedDocument = {
  id: string;
  type: GeneratedDocumentType;
  analysisId: string;
  status: GeneratedDocumentStatus;
  markdownContent: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

const TERMINAL_GENERATED_DOCUMENT_STATUSES: ReadonlySet<GeneratedDocumentStatus> = new Set([
  "READY",
  "FAILED",
]);

const GENERATED_DOCUMENT_POLL_INTERVAL_MS = 3000;

/** Kicks off generation for an Analysis (`POST /api/analyses/{id}/generated-documents`),
 * returning the two freshly created PENDING rows. */
export function useCreateGeneratedDocuments(analysisId: string) {
  return useMutation({
    mutationFn: () =>
      bff.post<{ generatedDocuments: GeneratedDocument[] }>(
        `/analyses/${analysisId}/generated-documents`,
      ),
  });
}

/** One GeneratedDocument, polled while it is PENDING/GENERATING. `id` may be
 * `null` before generation has been triggered — the query stays disabled. */
export function useGeneratedDocument(id: string | null) {
  return useQuery({
    queryKey: ["generated-document", id],
    queryFn: () => bff.get<{ generatedDocument: GeneratedDocument }>(`/generated-documents/${id}`),
    select: (data) => data.generatedDocument,
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.generatedDocument.status;
      return status && TERMINAL_GENERATED_DOCUMENT_STATUSES.has(status)
        ? false
        : GENERATED_DOCUMENT_POLL_INTERVAL_MS;
    },
  });
}
