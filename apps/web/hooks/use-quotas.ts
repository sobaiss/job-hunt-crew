"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// The caller's Effective quota + current usage for all four QuotaKinds
// (`GET /api/quotas`, issue #141) — backs the Quotas page and replaces the
// retired `useAnalysisQuota`/`useGeneratedDocumentsQuota` (each of which only
// covered one or two of the four kinds via their own now-removed endpoints).
// `alerts` (issue #142) is the caller's unread QuotaAlerts, oldest first —
// backs the notification feed and the inline blocked-action banners.

export type QuotaUsage = { cap: number | null; used: number; remaining: number | null };

export type QuotaKindName =
  | "activeScouts"
  | "analysesDaily"
  | "analysesMonthly"
  | "documentsDaily";

export type QuotaAlertThreshold = "APPROACHING" | "EXCEEDED";

export type QuotaAlert = {
  id: string;
  quotaKind: string;
  threshold: QuotaAlertThreshold;
  createdAt: string;
};

export type Quotas = {
  activeScouts: QuotaUsage;
  analysesDaily: QuotaUsage;
  analysesMonthly: QuotaUsage;
  documentsDaily: QuotaUsage;
  alerts: QuotaAlert[];
};

export function useQuotas() {
  return useQuery({
    queryKey: ["quotas"],
    queryFn: () => bff.get<Quotas>("/quotas"),
  });
}

/** Dismisses one unread QuotaAlert (`POST /api/quota-alerts/{id}/read`),
 * invalidating the shared quotas query so the feed and every inline banner
 * drop it immediately. */
export function useMarkQuotaAlertRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) =>
      bff.post<QuotaAlert>(`/quota-alerts/${alertId}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quotas"] });
    },
  });
}
