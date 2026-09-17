"use client";

import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// The caller's Effective quota + current usage for all four QuotaKinds
// (`GET /api/quotas`, issue #141) — backs the Quotas page and replaces the
// retired `useAnalysisQuota`/`useGeneratedDocumentsQuota` (each of which only
// covered one or two of the four kinds via their own now-removed endpoints).

export type QuotaUsage = { cap: number | null; used: number; remaining: number | null };

export type Quotas = {
  activeScouts: QuotaUsage;
  analysesDaily: QuotaUsage;
  analysesMonthly: QuotaUsage;
  documentsDaily: QuotaUsage;
};

export function useQuotas() {
  return useQuery({
    queryKey: ["quotas"],
    queryFn: () => bff.get<Quotas>("/quotas"),
  });
}
