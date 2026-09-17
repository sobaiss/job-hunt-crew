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

// Backs the admin reporting screen (issue #140): the plan-defaults editor,
// the per-user usage table with its at/over-limit filter, and the global
// stats panel.
export type AdminPlanDefault = { plan: string; quotaKind: string; limit: number | null };

export function useAdminPlanDefaults() {
  return useQuery({
    queryKey: ["admin-plan-defaults"],
    queryFn: () => bff.get<{ defaults: AdminPlanDefault[] }>("/admin/plan-defaults"),
  });
}

export function useSetPlanDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ plan, kind, limit }: { plan: string; kind: string; limit: number | null }) =>
      bff.put<AdminPlanDefault>(`/admin/plan-defaults/${plan}/${kind}`, { limit }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-plan-defaults"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
}

export type AdminUserSummary = {
  userId: string;
  email: string | null;
  plan: string;
  quotas: Record<string, AdminQuotaUsage>;
  atOrOverLimit: boolean;
};

export function useAdminUsers(atOrOverLimit: boolean) {
  return useQuery({
    queryKey: ["admin-users", atOrOverLimit],
    queryFn: () =>
      bff.get<{ users: AdminUserSummary[] }>(
        `/admin/users${atOrOverLimit ? "?atOrOverLimit=true" : ""}`,
      ),
  });
}

export type AdminStats = {
  totalUsers: number;
  usersOverLimitCount: number;
  analysesRequestedToday: number;
  analysesRequestedThisMonth: number;
  documentsCreatedToday: number;
  activeScoutsTotal: number;
};

export function useAdminStats() {
  return useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => bff.get<AdminStats>("/admin/stats"),
  });
}
