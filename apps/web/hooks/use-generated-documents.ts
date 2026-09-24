"use client";

import { useMutation, useQueries, useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// "Generate documents" on a relevant find (issue #58, Scout slice 6):
// creates a COVER_LETTER + a TAILORED_CV GeneratedDocument for a completed
// Analysis and polls each until it leaves PENDING/GENERATING. The download
// itself is a plain link to /api/generated-documents/{id}/download?format=...
// (see generated-documents-panel.tsx), not a hook.

export type GeneratedDocumentType = "COVER_LETTER" | "TAILORED_CV";
export type GeneratedDocumentStatus = "PENDING" | "GENERATING" | "READY" | "FAILED";

// Issue #95: every READY GeneratedDocument can be downloaded in any of these
// formats, all rendered on demand from the same generic template.
export const GENERATED_DOCUMENT_FORMATS = ["pdf", "docx", "md", "txt"] as const;
export type GeneratedDocumentFormat = (typeof GENERATED_DOCUMENT_FORMATS)[number];

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
 * returning the freshly created PENDING rows. Pass a `type` to produce just
 * that document — which is what the panel's two buttons do, each costing 1
 * against DOCUMENTS_DAILY rather than 2 (docs/adr/0031); omit it to get both,
 * as the bulk action and the Admin table still do. */
export function useCreateGeneratedDocuments(analysisId: string) {
  return useMutation({
    mutationFn: (type?: GeneratedDocumentType) =>
      bff.post<{ generatedDocuments: GeneratedDocument[] }>(
        `/analyses/${analysisId}/generated-documents`,
        type ? { type } : undefined,
      ),
  });
}

/** The Analysis's current GeneratedDocuments, if generation has already run —
 * lets the panel and the "Apply" action know what's ready after a reload,
 * without re-triggering generation. Empty array before generation starts. */
export function useAnalysisGeneratedDocuments(analysisId: string) {
  return useQuery({
    queryKey: ["analysis-generated-documents", analysisId],
    queryFn: () =>
      bff.get<{ generatedDocuments: GeneratedDocument[] }>(
        `/analyses/${analysisId}/generated-documents`,
      ),
    select: (data) => data.generatedDocuments,
  });
}

/** Regenerates a READY/FAILED GeneratedDocument (`POST
 * /api/generated-documents/{id}/regenerate`): the API creates a fresh
 * PENDING row of the same type and supersedes this one, so the caller
 * should swap to polling the returned row's id. 409 if the document is
 * still PENDING/GENERATING; 429 if the caller's DOCUMENTS_DAILY quota is exhausted. */
export function useRegenerateGeneratedDocument(id: string) {
  return useMutation({
    mutationFn: () =>
      bff.post<{ generatedDocument: GeneratedDocument }>(
        `/generated-documents/${id}/regenerate`,
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

/** Kicks off generation (issue #68's bulk action) for every Analysis in
 * `analysisIds`, one `POST /api/analyses/{id}/generated-documents` call per
 * id via `Promise.allSettled` — mirrors `useBulkSetApplicationStatus`'s
 * fan-out so a failure on one Analysis doesn't abort the rest. Returns the
 * ids that failed and the full list of freshly created document ids, so the
 * caller can poll each with {@link useGeneratedDocumentsStatuses}. */
export function useBulkCreateGeneratedDocuments() {
  return useMutation({
    mutationFn: async (analysisIds: string[]) => {
      const results = await Promise.allSettled(
        analysisIds.map((analysisId) =>
          bff.post<{ generatedDocuments: GeneratedDocument[] }>(
            `/analyses/${analysisId}/generated-documents`,
          ),
        ),
      );
      const failedAnalysisIds = analysisIds.filter(
        (_, i) => results[i]!.status === "rejected",
      );
      const documentIds = results
        .filter(
          (result): result is PromiseFulfilledResult<{ generatedDocuments: GeneratedDocument[] }> =>
            result.status === "fulfilled",
        )
        .flatMap((result) => result.value.generatedDocuments.map((document) => document.id));
      return { failedAnalysisIds, documentIds };
    },
  });
}

/** Polls a fixed list of GeneratedDocument ids (the bulk "Générer les
 * documents" run's own rows), each until it leaves PENDING/GENERATING —
 * lets the bulk-actions bar show a live per-run summary without a
 * full-page reload. Shares its cache entries with {@link useGeneratedDocument}. */
export function useGeneratedDocumentsStatuses(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["generated-document", id],
      queryFn: () =>
        bff.get<{ generatedDocument: GeneratedDocument }>(`/generated-documents/${id}`),
      select: (data: { generatedDocument: GeneratedDocument }) => data.generatedDocument,
      refetchInterval: (query: { state: { data?: { generatedDocument: GeneratedDocument } } }) => {
        const status = query.state.data?.generatedDocument.status;
        return status && TERMINAL_GENERATED_DOCUMENT_STATUSES.has(status)
          ? false
          : GENERATED_DOCUMENT_POLL_INTERVAL_MS;
      },
    })),
  });
}
