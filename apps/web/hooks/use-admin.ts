"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// Backs the bare Admin area landing page (issue #138) — confirms the
// session's Plan actually cleared services/api's `require_admin` end to end.
export type AdminMe = { userId: string; plan: string };

export function useAdminMe() {
  return useQuery({
    queryKey: ["admin-me"],
    queryFn: () => bff.get<AdminMe>("/admin/me"),
  });
}

// Backs the admin per-user detail screen (issue #139): a target User's
// Plan, Effective quota, current usage, and which QuotaKinds carry an
// explicit QuotaOverride, keyed by QuotaKind (e.g. "ANALYSES_DAILY").
export type AdminQuotaUsage = {
  cap: number | null;
  used: number;
  remaining: number | null;
  hasOverride: boolean;
};

export type AdminUserQuotas = {
  userId: string;
  plan: string;
  quotas: Record<string, AdminQuotaUsage>;
};

export function useAdminUserQuotas(userId: string) {
  return useQuery({
    queryKey: ["admin-user-quotas", userId],
    queryFn: () => bff.get<AdminUserQuotas>(`/admin/users/${userId}/quotas`),
  });
}

export function useSetQuotaOverride(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, limit }: { kind: string; limit: number | null }) =>
      bff.put<{ quotaKind: string; limit: number | null }>(
        `/admin/users/${userId}/quota-overrides/${kind}`,
        { limit },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
    },
  });
}

export function useClearQuotaOverride(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: string) =>
      bff.delete<void>(`/admin/users/${userId}/quota-overrides/${kind}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
    },
  });
}

export function useSetUserPlan(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: string) =>
      bff.put<{ userId: string; plan: string }>(`/admin/users/${userId}/plan`, { plan }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
    },
  });
}
