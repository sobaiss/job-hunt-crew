"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";
import { adminUsersTableStateToQuery, type AdminUsersTableState } from "@/lib/admin-users-filters";
import {
  adminCvVersionsTableStateToQuery,
  type AdminCvVersionsTableState,
} from "@/lib/admin-cv-versions-filters";
import {
  adminAnalysesTableStateToQuery,
  type AdminAnalysesTableState,
} from "@/lib/admin-analyses-filters";
import {
  adminScoutsTableStateToQuery,
  type AdminScoutsTableState,
} from "@/lib/admin-scouts-filters";

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

// Backs the Admin "LLM providers" screen (issue #174, docs/adr/0024): the five
// providers the system implements, what each one needs and whether it is ready
// to run. A secret never carries its value -- only `isSet` and, for a stored
// one, the `lastFour` hint (null for an environment-supplied secret).
export type AdminLlmProviderParameter = {
  name: string;
  secret: boolean;
  required: boolean;
  source: "stored" | "environment" | "default" | "unresolved";
  value: string | null;
  isSet: boolean;
  lastFour: string | null;
};

export type AdminLlmProvider = {
  key: string;
  displayName: string;
  maturity: "production" | "opt-in" | "dev-local";
  active: boolean;
  configuration: "configured" | "inherited" | "incomplete";
  updatedAt: string | null;
  settingId: string | null;
  parameters: AdminLlmProviderParameter[];
};

export type AdminLlmProviderSettings = {
  activeProvider: string | null;
  // The provider LLM_PROVIDER resolves to in the API's environment, or the
  // unsupported value it holds.
  environmentProvider: { key: string | null; unsupportedValue: string | null };
  providers: AdminLlmProvider[];
};

export function useAdminLlmProviderSettings() {
  return useQuery({
    queryKey: ["admin-llm-provider-settings"],
    queryFn: () => bff.get<AdminLlmProviderSettings>("/admin/llm-provider-settings"),
  });
}

// Saves one provider's parameters (issues #175, #179). Per parameter: a string
// sets it (blank removes a stored non-secret; a blank secret is unchanged),
// null clears it, an omitted name is left unchanged -- so only changed fields
// should be passed.
export function useSaveLlmProviderSettings(providerKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (parameters: Record<string, string | null>) =>
      bff.put<AdminLlmProvider>(`/admin/llm-provider-settings/${providerKey}`, { parameters }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-llm-provider-settings"] });
    },
  });
}

// Activation (issue #176). Both refresh the list whether they succeed or are
// refused, so the table always shows what is actually active.
function useRefreshLlmProviderSettings() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-llm-provider-settings"] });
  };
}

// Makes one provider the only active one; the API refuses with a 422 naming
// each required parameter that resolves nowhere.
export function useActivateLlmProvider() {
  const refresh = useRefreshLlmProviderSettings();
  return useMutation({
    mutationFn: (providerKey: string) =>
      bff.post<AdminLlmProviderSettings>(`/admin/llm-provider-settings/${providerKey}/activate`),
    onSettled: refresh,
  });
}

// Hands control back to the environment (the None row).
export function useDeactivateLlmProvider() {
  const refresh = useRefreshLlmProviderSettings();
  return useMutation({
    mutationFn: () => bff.post<AdminLlmProviderSettings>("/admin/llm-provider-settings/deactivate"),
    onSettled: refresh,
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

// `enabled` lets a caller (the CandidatePicker's type-ahead, issue #160) defer
// the query until it actually needs suggestions, instead of always fetching.
export function useAdminUsers(state: AdminUsersTableState, options?: { enabled?: boolean }) {
  const qs = adminUsersTableStateToQuery(state).toString();
  return useQuery({
    queryKey: ["admin-users", qs],
    queryFn: () => bff.get<AdminUsersListResponse>(`/admin/users?${qs}`),
    enabled: options?.enabled ?? true,
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

// Backs the Admin CV versions table (issue #163): every candidate's
// CVVersion in one cross-user, filterable, paginated list — superseded rows
// are hidden unless `includeSuperseded` is set, same as the candidate-facing
// table. The owner's name/email are resolved server-side (mirroring the
// audit-events actor resolution) so the table never does its own per-row
// lookup.
export type AdminCvVersionRow = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  label: string;
  fileName: string;
  fileType: string;
  isDefault: boolean;
  conversionStatus: string;
  conversionError: string | null;
  supersededById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminCvVersionsListResponse = {
  cvVersions: AdminCvVersionRow[];
  total: number;
  page: number;
  pageSize: number;
};

export function useAdminCvVersions(state: AdminCvVersionsTableState) {
  const qs = adminCvVersionsTableStateToQuery(state).toString();
  return useQuery({
    queryKey: ["admin-cv-versions", qs],
    queryFn: () => bff.get<AdminCvVersionsListResponse>(`/admin/cv-versions?${qs}`),
  });
}

// Backs the Reconvert row action (issue #163) — the only write action this
// table offers. Ownership never moves to the admin caller; the response is
// only the new conversionStatus, so a full refetch of the list picks up the
// row's new state.
export function useReconvertCvVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cvVersionId: string) =>
      bff.post<{ cvVersionId: string; conversionStatus: string }>(
        `/admin/cv-versions/${cvVersionId}/reconvert`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-cv-versions"] });
    },
  });
}

// Backs the Admin analyses table (issue #161): every candidate's Analysis in
// one cross-user, filterable, paginated list. `status` is the Analysis's own
// pipeline status; `applicationStatus` (or its absence) is folded into the
// read-only Tracking-status badge the same way the candidate-facing page's
// `trackingStatusOf` does — no status-transition endpoint exists here.
export type AdminAnalysisRow = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  jobOfferId: string;
  jobOfferTitle: string | null;
  jobOfferCompany: string | null;
  status: string;
  applicationStatus: string | null;
  requestedAt: string;
  completedAt: string | null;
};

export type AdminAnalysesListResponse = {
  analyses: AdminAnalysisRow[];
  total: number;
  page: number;
  pageSize: number;
};

export function useAdminAnalyses(state: AdminAnalysesTableState) {
  const qs = adminAnalysesTableStateToQuery(state).toString();
  return useQuery({
    queryKey: ["admin-analyses", qs],
    queryFn: () => bff.get<AdminAnalysesListResponse>(`/admin/analyses?${qs}`),
  });
}

// Backs the "Relancer l'analyse" row action (issue #161) — creates a new
// Analysis owned by the original candidate. A full refetch of the list picks
// up the new row.
export function useRetryAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: string) =>
      bff.post<{ analysisId: string; status: string }>(`/admin/analyses/${analysisId}/retry`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-analyses"] });
    },
  });
}

// Backs the "Générer les documents" row action (issue #161) — creates
// GeneratedDocuments (and, lazily, the owning Application) for the target
// Analysis, still owned by the original candidate.
export function useGenerateAnalysisDocuments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: string) =>
      bff.post<{ generatedDocuments: { id: string; type: string; status: string }[] }>(
        `/admin/analyses/${analysisId}/generated-documents`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-analyses"] });
    },
  });
}

// Backs the Admin scouts table (issue #162): every candidate's Scout in one
// cross-user, filterable, paginated list. No Edit or Create control exists
// anywhere on this table — a Scout's configuration and creation stay
// exclusively the candidate's own.
export type AdminScoutRow = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  label: string;
  status: string;
  matchThreshold: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminScoutsListResponse = {
  scouts: AdminScoutRow[];
  total: number;
  page: number;
  pageSize: number;
};

export function useAdminScouts(state: AdminScoutsTableState) {
  const qs = adminScoutsTableStateToQuery(state).toString();
  return useQuery({
    queryKey: ["admin-scouts", qs],
    queryFn: () => bff.get<AdminScoutsListResponse>(`/admin/scouts?${qs}`),
  });
}

// Backs the "Run now" row action (issue #162) — mirrors the candidate-facing
// `useRunScout`'s same rate limit (services/api shares the one-per-hour
// throttle between the candidate and admin endpoints). A full refetch of the
// list picks up the Scout's unchanged row plus any later lastRunAt stamp
// once the scout worker finishes.
export function useAdminRunScout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scoutId: string) =>
      bff.post<{ scoutId: string; scoutRunId: string; status: string }>(
        `/admin/scouts/${scoutId}/run`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-scouts"] });
    },
  });
}

// Backs the Pause row action (issue #162).
export function useAdminPauseScout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scoutId: string) =>
      bff.post<{ scoutId: string; status: string }>(`/admin/scouts/${scoutId}/pause`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-scouts"] });
    },
  });
}

// Backs the Resume row action (issue #162) — rejected (409) by services/api
// for an ARCHIVED Scout, since there is no admin-facing unarchive.
export function useAdminResumeScout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scoutId: string) =>
      bff.post<{ scoutId: string; status: string }>(`/admin/scouts/${scoutId}/resume`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-scouts"] });
    },
  });
}

// Backs the Archive row action (issue #162) — deliberately one-directional;
// this table offers no unarchive counterpart.
export function useAdminArchiveScout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scoutId: string) =>
      bff.post<{ scoutId: string; status: string }>(`/admin/scouts/${scoutId}/archive`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-scouts"] });
    },
  });
}
