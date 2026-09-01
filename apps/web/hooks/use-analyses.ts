"use client";

import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// TanStack Query read hooks for the analyses area, layered on the typed BFF
// client (`lib/bff-client.ts`). The `/api/*` contract is unchanged — these
// hooks only move the fetching, polling and terminal-state logic that used to
// live as hand-rolled `useEffect` + `setInterval` in the pages.

export type AnalysisStatus =
  | "PENDING"
  | "QUEUED"
  | "RUNNING_CREW"
  | "AWAITING_RESULT"
  | "PERSISTING"
  | "COMPLETED"
  | "FAILED";

/** Once an Analysis reaches one of these, the detail page stops polling. */
export const TERMINAL_ANALYSIS_STATUSES: ReadonlySet<AnalysisStatus> = new Set([
  "COMPLETED",
  "FAILED",
]);

/** Detail poll cadence, preserved from the previous hand-rolled polling. */
export const ANALYSIS_POLL_INTERVAL_MS = 3000;

export type MatchedSkill = { skill: string; evidence: string };
export type MissingSkill = {
  skill: string;
  importance: "required" | "nice_to_have";
};
export type ImprovementSuggestion = {
  area: string;
  suggestion: string;
  priority: "high" | "medium" | "low";
};

export type AnalysisResult = {
  match_score: number;
  matched_skills: MatchedSkill[];
  missing_skills: MissingSkill[];
  strengths: string[];
  weaknesses: string[];
  improvement_suggestions: ImprovementSuggestion[];
  summary: string;
  generated_at?: string;
  model_used?: string;
};

export type AnalysisSummary = {
  id: string;
  status: AnalysisStatus;
  matchScore: number | null;
  requestedAt: string;
  jobOffer: { id: string; title: string | null; company: string | null };
  cvVersion: { label: string };
};

export type AnalysisDetail = AnalysisSummary & {
  resultJSON: AnalysisResult | null;
  errorMessage: string | null;
};

/**
 * The analyses list. Pass `jobOfferId` to scope it to one JobOffer (used by the
 * Side-by-side comparison in ticket #10), or `ingestionJobId` to scope it to
 * one IngestionJob's Analysis batch (used by the "Analyse one offer" waiting
 * state and, later, the Batch result view).
 *
 * When `ingestionJobId` is set the query polls every
 * {@link ANALYSIS_POLL_INTERVAL_MS} until at least one Analysis exists, then
 * stops — the "Analyse one offer" waiting state only needs the first row.
 *
 * The Batch result view instead passes `batchRunning` (its IngestionJob's
 * non-terminal state): while that is `true`, or while any loaded Analysis is
 * still non-terminal, the query keeps polling so newly fanned-out rows and
 * their scores fill in; it stops once the run is terminal and every Analysis
 * in the batch is too (or the run ended with none).
 *
 * The `/v1/analyses` list endpoint serialises each row with the same shape as
 * the detail endpoint (`resultJSON` and `errorMessage` included), so the list
 * items are `AnalysisDetail`. The Dashboard only reads the summary fields; the
 * comparison view reads `resultJSON` per column.
 */
export function useAnalyses(params?: {
  jobOfferId?: string;
  ingestionJobId?: string;
  batchRunning?: boolean;
}) {
  const jobOfferId = params?.jobOfferId;
  const ingestionJobId = params?.ingestionJobId;
  const batchRunning = params?.batchRunning;

  const query = new URLSearchParams();
  if (jobOfferId) query.set("jobOfferId", jobOfferId);
  if (ingestionJobId) query.set("ingestionJobId", ingestionJobId);
  const search = query.toString() ? `?${query.toString()}` : "";

  return useQuery({
    queryKey: ["analyses", jobOfferId ?? null, ingestionJobId ?? null],
    queryFn: () => bff.get<{ analyses: AnalysisDetail[] }>(`/analyses${search}`),
    select: (data) => data.analyses,
    refetchInterval: (q) => {
      if (!ingestionJobId) return false;
      const analyses = q.state.data?.analyses ?? [];
      if (batchRunning === undefined) {
        return analyses.length > 0 ? false : ANALYSIS_POLL_INTERVAL_MS;
      }
      const batchTerminal =
        analyses.length === 0 ||
        analyses.every((a) => TERMINAL_ANALYSIS_STATUSES.has(a.status));
      return batchRunning || !batchTerminal ? ANALYSIS_POLL_INTERVAL_MS : false;
    },
  });
}

/**
 * One Analysis. Polls every {@link ANALYSIS_POLL_INTERVAL_MS} while the status is
 * non-terminal and stops once it is `COMPLETED` or `FAILED`.
 */
export function useAnalysis(id: string) {
  return useQuery({
    queryKey: ["analysis", id],
    queryFn: () => bff.get<{ analysis: AnalysisDetail }>(`/analyses/${id}`),
    select: (data) => data.analysis,
    refetchInterval: (query) => {
      const status = query.state.data?.analysis.status;
      return status && TERMINAL_ANALYSIS_STATUSES.has(status)
        ? false
        : ANALYSIS_POLL_INTERVAL_MS;
    },
  });
}
