"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// TanStack Query hooks for the Applications tracker (issue #59, Scout slice
// 7). An Application tracks a Candidate's pursuit of one Analysis's offer
// through a status pipeline; it is created lazily via `useCreateApplication`
// (idempotent per analysisId — a second call returns the existing row) and
// advanced by appending StatusEvents, never by editing `status` directly.

export const APPLICATION_STATUS_VALUES = [
  "DRAFT",
  "APPLIED",
  "INTERVIEWING",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUS_VALUES)[number];

export type Application = {
  id: string;
  userId: string;
  analysisId: string;
  jobOfferId: string;
  cvVersionId: string;
  scoutId: string | null;
  coverLetterDocId: string | null;
  tailoredCvDocId: string | null;
  status: ApplicationStatus;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  jobOffer: { id: string; title: string | null; company: string | null };
  cvVersion: { label: string };
};

export type StatusEvent = {
  id: string;
  applicationId: string;
  status: ApplicationStatus;
  note: string | null;
  effectiveDate: string;
  createdAt: string;
};

export type ApplicationDetail = Application & {
  jobOffer: { id: string; sourceUrl: string; title: string | null; company: string | null };
  statusEvents: StatusEvent[];
};

const APPLICATIONS_KEY = ["applications"] as const;

/** The caller's Applications, optionally filtered by status and/or Scout. */
export function useApplications(filters?: { status?: ApplicationStatus; scoutId?: string }) {
  const status = filters?.status;
  const scoutId = filters?.scoutId;

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (scoutId) query.set("scoutId", scoutId);
  const search = query.toString() ? `?${query.toString()}` : "";

  return useQuery({
    queryKey: [...APPLICATIONS_KEY, status ?? null, scoutId ?? null] as const,
    queryFn: () => bff.get<{ applications: Application[] }>(`/applications${search}`),
    select: (data) => data.applications,
  });
}

/** One Application, with its JobOffer and full StatusEvent timeline. */
export function useApplication(id: string | null) {
  return useQuery({
    queryKey: [...APPLICATIONS_KEY, id] as const,
    queryFn: () => bff.get<{ application: ApplicationDetail }>(`/applications/${id}`),
    select: (data) => data.application,
    enabled: id !== null,
  });
}

/** Lazily gets-or-creates the Application for an Analysis: the first call
 * creates it (DRAFT), a later call for the same analysisId returns the
 * existing row unchanged. Backs both "Mark as applied" and, later,
 * "Generate documents". */
export function useCreateApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: string) =>
      bff.post<{ application: Application }>("/applications", { analysisId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: APPLICATIONS_KEY });
    },
  });
}

/** Appends a StatusEvent, advancing (or undoing, by appending a prior
 * status) the Application's derived `status`/`appliedAt`. */
export function useAddStatusEvent(applicationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { status: ApplicationStatus; note?: string; effectiveDate?: string }) =>
      bff.post<{ application: Application; statusEvent: StatusEvent }>(
        `/applications/${applicationId}/status-events`,
        input,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: APPLICATIONS_KEY });
    },
  });
}

/** "Mark as applied" (issue #59): composes the lazy get-or-create with an
 * APPLIED StatusEvent in one action, for the Analysis detail page's action
 * button — the caller doesn't need to know the Application id ahead of time. */
export function useMarkAsApplied() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (analysisId: string) => {
      const { application } = await bff.post<{ application: Application }>("/applications", {
        analysisId,
      });
      return bff.post<{ application: Application; statusEvent: StatusEvent }>(
        `/applications/${application.id}/status-events`,
        { status: "APPLIED", effectiveDate: new Date().toISOString() },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: APPLICATIONS_KEY });
    },
  });
}
