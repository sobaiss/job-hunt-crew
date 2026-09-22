"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff, BffError } from "@/lib/bff-client";

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

/** How long a presigned upload URL stays valid (services/api signs it for 5 minutes). */
export const CV_UPLOAD_URL_TTL_MS = 5 * 60 * 1000;

/** A CVVersion row whose bytes may not be in storage yet, and when it was created. */
export type CreatedCvVersion = CreateCvVersionResponse & { createdAt: number };

/**
 * Which part of storing a CV failed (issue #195): the create request never
 * reached the API (`network`), the API refused or broke (`server`), or the
 * row exists but the bytes never reached storage (`upload`). `created` is set
 * once the row exists, so a retry can re-send to the same presigned URL and a
 * close can discard the orphan row.
 */
export class CvStoreError extends Error {
  readonly reason: "network" | "server" | "upload";
  readonly detail: string | null;
  readonly created: CreatedCvVersion | null;

  constructor(
    reason: CvStoreError["reason"],
    detail: string | null,
    created: CreatedCvVersion | null,
  ) {
    super(`Storing the CV failed (${reason})`);
    this.name = "CvStoreError";
    this.reason = reason;
    this.detail = detail;
    this.created = created;
  }
}

/**
 * The human-readable `detail` services/api put on an error response, if any:
 * a plain string, or the `message` of a `{code, message}` detail.
 */
export function apiErrorDetail(error: unknown): string | null {
  if (!(error instanceof BffError)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null) return null;
  const { detail } = body as { detail?: unknown };
  if (typeof detail === "string") return detail;
  if (typeof detail === "object" && detail !== null) {
    const { message } = detail as { message?: unknown };
    if (typeof message === "string") return message;
  }
  return null;
}

async function putCvFile(uploadUrl: string, file: File): Promise<void> {
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Upload failed with ${uploadResponse.status}`);
  }
}

/**
 * Delete a CVVersion that has no file behind it, best-effort: a failure is
 * swallowed, never surfaced (issue #195). Only the Import screen's explicit
 * close calls this, and only after storing failed.
 */
export function discardCvVersion(id: string): void {
  void bff.delete<void>(`/cv-versions/${id}`).catch(() => {
    // Swallowed on purpose; the row stays deletable from the list.
  });
}

/**
 * Create a CVVersion then PUT the bytes straight to the presigned URL.
 * Fails with a {@link CvStoreError} naming which half broke. Given the
 * `previous` row of a failed attempt, re-sends to its URL while that is still
 * valid; once it has expired, discards that row and starts over. Invalidates
 * the list on success so the new row (and its `PENDING` status) appears.
 */
export function useCreateCvVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      label,
      file,
      previous,
    }: {
      label: string;
      file: File;
      previous?: CreatedCvVersion | null;
    }): Promise<CreatedCvVersion> => {
      let created: CreatedCvVersion;
      if (previous && Date.now() - previous.createdAt < CV_UPLOAD_URL_TTL_MS) {
        created = previous;
      } else {
        if (previous) discardCvVersion(previous.cvVersionId);
        try {
          const response = await bff.post<CreateCvVersionResponse>(
            "/cv-versions",
            {
              label,
              fileName: file.name,
              contentType: file.type,
              fileSizeBytes: file.size,
            },
          );
          created = { ...response, createdAt: Date.now() };
        } catch (error) {
          const network = error instanceof BffError && error.status === 0;
          throw new CvStoreError(
            network ? "network" : "server",
            apiErrorDetail(error),
            null,
          );
        }
      }

      try {
        await putCvFile(created.uploadUrl, file);
      } catch {
        throw new CvStoreError("upload", null, created);
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
 * it, and transfers `isDefault` when the old row held it; this hook then
 * starts the new row's Conversion itself, after the PUT — unless
 * `startConversion` is false, for a caller (the Import screen) that starts
 * and follows it on its own. Invalidates the list on success so the new row
 * appears and the replaced row drops out of the default (non-superseded) view.
 */
export function useReplaceCvVersion({
  startConversion = true,
}: { startConversion?: boolean } = {}) {
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

      await putCvFile(created.uploadUrl, file);
      if (!startConversion) return created;

      // The file first, the Conversion second (docs/adr/0028): services/api
      // cannot start it on replace, the bytes only exist once this PUT is
      // done. A failure here does not fail the Replace — the new CVVersion
      // exists with its file stored, and the table's "Convert to Markdown"
      // action is the recovery.
      try {
        await bff.post(`/cv-versions/${created.cvVersionId}/convert`);
      } catch {
        // Swallowed on purpose; see above.
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
  /** Why the last Conversion failed, verbatim from services/api. */
  conversionError?: string | null;
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

/** Conversion statuses after which nothing moves without a new convert. */
export const TERMINAL_CV_CONVERSION_STATUSES: ReadonlySet<CvConversionStatus> =
  new Set(["CONVERTED", "FAILED"]);

/** How often the Import screen re-reads a CVVersion's Conversion. */
export const CV_CONVERSION_POLL_INTERVAL_MS = 2000;

/**
 * The same rendition query as {@link useCvVersionMarkdown}, polled until the
 * Conversion reaches a terminal status — the Import screen's progress source.
 * The endpoint answers the status and the content together, so the success
 * state renders from the last poll with no extra request. `id` is null until
 * the Conversion has been started.
 */
export function useCvVersionConversion(id: string | null) {
  return useQuery({
    queryKey: ["cv-versions", id, "markdown"] as const,
    queryFn: () => bff.get<CvVersionMarkdown>(`/cv-versions/${id}/markdown`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.conversionStatus;
      return status && TERMINAL_CV_CONVERSION_STATUSES.has(status)
        ? false
        : CV_CONVERSION_POLL_INTERVAL_MS;
    },
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
 * `PENDING` and enqueues the work on the `cv-conversion` queue. A 409 carries
 * `detail.code`: `CONVERSION_RUNNING` (one is already running) or
 * `FILE_NOT_UPLOADED` (no object at the CV's fileKey yet, docs/adr/0028).
 * Invalidates the list so the new status shows.
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
