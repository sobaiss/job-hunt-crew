"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";
import { adminUsersTableStateToQuery, type AdminUsersTableState } from "@/lib/admin-users-filters";

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
  name: string | null;
  email: string | null;
  plan: string;
  planEndDate: string | null;
  role: string;
  blocked: boolean;
  createdAt: string;
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

// Assigns or renews `userId`'s Subscription (issue #155, docs/adr/0018):
// `duration` is required for standard/premium and omitted for free — the
// server computes `endDate` from it, never accepted here.
export function useSetUserPlan(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ plan, duration }: { plan: string; duration?: string | null }) =>
      bff.put<{ userId: string; plan: string; endDate: string | null }>(
        `/admin/users/${userId}/plan`,
        { plan, duration: duration ?? null },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
}

// Backs the block/unblock action on the Admin users table row and the User
// panel (issue #148).
export function useSetUserBlocked(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blocked: boolean) =>
      bff.put<{ userId: string; blocked: boolean }>(`/admin/users/${userId}/blocked`, {
        blocked,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
}

// Backs the name-edit action in the User panel (issue #149). Email is
// never sent here — the underlying endpoint never accepts it.
export function useSetUserInfo(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      bff.put<{ userId: string; name: string | null }>(`/admin/users/${userId}/info`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
}

// Backs the Role select in the User panel (issue #156, replacing the
// isAdmin grant/revoke action from #149 per docs/adr/0017).
export function useSetUserRole(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (role: string) =>
      bff.put<{ userId: string; role: string }>(`/admin/users/${userId}/role`, { role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-user-quotas", userId] });
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
}

// Backs the Plan defaults page (issue #146, replacing the #140 editor
// embedded in the Admin users table): the free/standard/premium comparison
// table, and the per-user usage table's at/over-limit filter and global
// stats panel also read this same list.
export type AdminPlanDefault = { plan: string; quotaKind: string; limit: number | null };

export function useAdminPlanDefaults() {
  return useQuery({
    queryKey: ["admin-plan-defaults"],
    queryFn: () => bff.get<{ defaults: AdminPlanDefault[] }>("/admin/plan-defaults"),
  });
}

// Saves every changed QuotaKind limit for `plan` in one action, matching the
// slide-over form's "all four kinds together" save (issue #146) — the
// backend only writes an AdminAuditEvent for kinds that actually changed.
export function useSetPlanDefaults(plan: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (limits: Record<string, number | null>) =>
      bff.put<{ defaults: AdminPlanDefault[] }>(`/admin/plan-defaults/${plan}`, { limits }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-plan-defaults"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
}

// Backs the Admin users table (issue #147): a lightweight row per User —
// Plan reassignment, quotas and overrides now live only on the User panel
// (useAdminUserQuotas above), reached via the row's id.
export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  plan: string;
  role: string;
  blocked: boolean;
  atOrOverLimit: boolean;
  createdAt: string;
};

export type AdminUsersListResponse = {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
};

export function useAdminUsers(state: AdminUsersTableState) {
  const qs = adminUsersTableStateToQuery(state).toString();
  return useQuery({
    queryKey: ["admin-users", qs],
    queryFn: () => bff.get<AdminUsersListResponse>(`/admin/users?${qs}`),
  });
}

// Backs the Audit history tab in the User panel (issue #150): every
// AdminAuditEvent recorded against a target User, newest first, with the
// acting Administrator's name/email already resolved server-side.
export type AdminAuditEventActor = { id: string; name: string | null; email: string | null };

export type AdminAuditEventItem = {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  actor: AdminAuditEventActor;
};

export function useAdminAuditEvents(userId: string) {
  return useQuery({
    queryKey: ["admin-user-audit-events", userId],
    queryFn: () => bff.get<{ events: AdminAuditEventItem[] }>(`/admin/users/${userId}/audit-events`),
    enabled: userId !== "",
  });
}

// Backs the Admin dashboard (issue #145). `period` filters only
// `newSignups` — every other field is a today-snapshot regardless of it.
export type AdminStatsPeriod = "7d" | "30d" | "90d" | "all";

export type AdminStats = {
  totalUsers: number;
  usersOverLimitCount: number;
  analysesRequestedToday: number;
  analysesRequestedThisMonth: number;
  documentsCreatedToday: number;
  activeScoutsTotal: number;
  newSignups: Array<{ date: string; count: number }>;
  usersByPlan: Record<string, number>;
  blockedUsersCount: number;
};

export function useAdminStats(period: AdminStatsPeriod = "all") {
  return useQuery({
    queryKey: ["admin-stats", period],
    queryFn: () => bff.get<AdminStats>(`/admin/stats?period=${period}`),
  });
}
