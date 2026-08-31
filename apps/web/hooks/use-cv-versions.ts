"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// TanStack Query read hook + mutations for the CV versions area, layered on the
// typed BFF client (`lib/bff-client.ts`). The `/api/*` contract and the
// presigned-PUT upload flow are unchanged — these hooks only move the fetching
// and the hand-rolled `useCallback` + `fetch` that used to live in the page,
// and invalidate the list on a successful write.

export type CvConversionStatus =
  | "PENDING"
  | "CONVERTING"
  | "CONVERTED"
  | "FAILED";
export type CvFileType = "PDF" | "DOCX" | "MD" | "TXT";

export type CvVersion = {
  id: string;
  label: string;
  fileName: string;
  fileType: CvFileType;
  fileSizeBytes: number;
  isDefault: boolean;
  conversionStatus: CvConversionStatus;
  conversionError: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Content types services/api accepts for a CV upload, mapped to the file-type
 * label it stores. Mirrors `CONTENT_TYPE_TO_FILE_TYPE` in
 * `services/api/src/api/v1.py`; the client validates against it so a bad file is
 * rejected before the create request.
 */
export const ACCEPTED_CV_CONTENT_TYPES: Record<string, CvFileType> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "text/markdown": "MD",
  "text/plain": "TXT",
};

/** PRD Section 13 default, mirrored from `MAX_FILE_SIZE_BYTES` in services/api. */
export const MAX_CV_SIZE_BYTES = 10 * 1024 * 1024;

const CV_VERSIONS_KEY = ["cv-versions"] as const;

/** The CV versions list, newest first (ordering comes from services/api). */
export function useCvVersions() {
  return useQuery({
    queryKey: CV_VERSIONS_KEY,
    queryFn: () => bff.get<{ cvVersions: CvVersion[] }>("/cv-versions"),
    select: (data) => data.cvVersions,
  });
}

type CreateCvVersionResponse = {
  cvVersionId: string;
  fileKey: string;
  uploadUrl: string;
};

/**
 * Create a CVVersion then PUT the bytes straight to the presigned URL, exactly
 * as the previous hand-rolled page did. Invalidates the list on success so the
 * new row (and its `PENDING` conversion status) appears.
 */
export function useCreateCvVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ label, file }: { label: string; file: File }) => {
      const created = await bff.post<CreateCvVersionResponse>("/cv-versions", {
        label,
        fileName: file.name,
        contentType: file.type,
        fileSizeBytes: file.size,
      });

      const uploadResponse = await fetch(created.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with ${uploadResponse.status}`);
      }

      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CV_VERSIONS_KEY });
    },
  });
}

export type CvVersionMarkdown = {
  markdownContent: string | null;
  conversionStatus: CvConversionStatus;
};

/**
 * The Markdown rendition of one CV version, for the read-only preview panel.
 * `enabled` is false until the panel is opened, so the content is only fetched
 * on demand (it is not inlined in the list response).
 */
export function useCvVersionMarkdown(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["cv-versions", id, "markdown"] as const,
    queryFn: () => bff.get<CvVersionMarkdown>(`/cv-versions/${id}/markdown`),
    enabled,
  });
}

/**
 * Trigger a Conversion for one CV version — "Convert to Markdown", or
 * "Reconvert" once it is `CONVERTED`. services/api resets `conversionStatus` to
 * `PENDING` and enqueues the work on the `cv-conversion` queue; a 409 means a
 * Conversion is already running. Invalidates the list so the new status shows.
 */
export function useConvertCvVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      bff.post<{ conversionStatus: CvConversionStatus }>(
        `/cv-versions/${id}/convert`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CV_VERSIONS_KEY });
    },
  });
}

/** Set one CVVersion as the default; services/api clears the previous default. */
export function useSetDefaultCvVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      bff.patch<{ cvVersion: CvVersion }>(`/cv-versions/${id}`, {
        isDefault: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CV_VERSIONS_KEY });
    },
  });
}
