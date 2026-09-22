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
  supersededById: string | null;
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

/** `accept` attribute for a CV `<input type="file">` — extensions + media types. */
export const CV_FILE_ACCEPT = [
  ".pdf",
  ".docx",
  ".md",
  ".txt",
  ...Object.keys(ACCEPTED_CV_CONTENT_TYPES),
].join(",");

/**
 * RHF stores the raw `input.files` for a file field. jsdom / user-event give a
 * `FileList`-like rather than a genuine `FileList` instance, so this duck-types
 * it instead of `instanceof FileList`. Shared by the CV management page and
 * the CV panel's Replace form.
 */
export function firstFile(value: unknown): File | undefined {
  if (value && typeof value === "object" && "length" in value) {
    const list = value as { length: number; [index: number]: unknown };
    if (list.length > 0 && list[0] instanceof File) {
      return list[0];
    }
  }
  return undefined;
}

const CV_VERSIONS_KEY = ["cv-versions"] as const;

/** The CV versions list, newest first (ordering comes from services/api). */
export function useCvVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: CV_VERSIONS_KEY,
    queryFn: () => bff.get<{ cvVersions: CvVersion[] }>("/cv-versions"),
    select: (data) => data.cvVersions,
    enabled: options?.enabled ?? true,
  });
}

export type CreateCvVersionResponse = {
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

/**
 * Replace an existing CVVersion with a new file, then PUT the bytes straight
 * to the presigned URL — same two-step shape as {@link useCreateCvVersion}.
 * services/api creates a new row, points the old row's `supersededById` at
 * it, transfers `isDefault` when the old row held it, and enqueues the new
 * row for Conversion. Invalidates the list on success so the new row appears
 * and the replaced row drops out of the default (non-superseded) view.
 */
export function useReplaceCvVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      label,
      file,
    }: {
      id: string;
      label: string;
      file: File;
    }) => {
      const created = await bff.post<CreateCvVersionResponse>(
        `/cv-versions/${id}/replace`,
        {
          label,
          fileName: file.name,
          contentType: file.type,
          fileSizeBytes: file.size,
        },
      );

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
 * Save a candidate's hand-edit of a CV version's Markdown rendition in place
 * (issue #186, #185, docs/adr/0025) — mutates the same CVVersion row, no new
 * row created. Invalidates both the list and this CV's own rendition query
 * on success, so the edit page's read-only view reflects the save without a
 * manual refetch.
 */
export function useSaveCvVersionMarkdown(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (markdownContent: string) =>
      bff.put<CvVersionMarkdown>(`/cv-versions/${id}/markdown`, {
        markdownContent,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CV_VERSIONS_KEY });
      queryClient.invalidateQueries({
        queryKey: ["cv-versions", id, "markdown"] as const,
      });
    },
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

/**
 * Delete a CV — the whole supersede chain the given (current, non-
 * superseded) CVVersion belongs to, not just that one row (docs/adr/0027).
 * services/api rejects with a 409 if any version in the chain has been used
 * in an Analysis, IngestionJob, Scout, Application, or GeneratedDocument.
 */
export function useDeleteCvVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => bff.delete<void>(`/cv-versions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CV_VERSIONS_KEY });
    },
  });
}
