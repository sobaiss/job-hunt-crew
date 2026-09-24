"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";
import type { ApplicationStatus } from "@/hooks/use-applications";
import type { GeneratedDocumentStatus } from "@/hooks/use-generated-documents";

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

/** IngestionMode as serialised by `/v1/ingestion-jobs`; only `SITE_SEARCH`
 *  rows are folded into a grouped Dashboard row (issue #34). */
export type IngestionMode = "SINGLE_URL" | "SITE_SEARCH" | "LISTING_URL";

export type AnalysisSummary = {
  id: string;
  status: AnalysisStatus;
  matchScore: number | null;
  requestedAt: string;
  /** When this Analysis was last re-driven in place by
   *  {@link useRequeueAnalysis}, or `null` if never (docs/adr/0032). */
  requeuedAt: string | null;
  /** Derived server-side, never stored: non-terminal but nothing has advanced
   *  it for a while, so a worker/queue restart most likely orphaned it. The
   *  rule lives in `py_db/stuck_analysis.py` and gates the requeue endpoint
   *  too, so the client reads this flag rather than re-guessing from
   *  timestamps. */
  stuck: boolean;
  cvVersionId: string;
  /** The batch this Analysis belongs to, or `null` for one created directly
   *  via `POST /v1/analyses`. */
  ingestionJobId: string | null;
  /** The Scout that discovered this offer, or `null` for a manual analysis.
   *  Set by the ingestion fan-out when the parent job carries a `scoutRunId`
   *  (issue #54). */
  scoutId: string | null;
  /** The linked Application's status, or `null` when none exists yet (it's
   *  created lazily) — folded into the Analyses table's 5-bucket Tracking
   *  status by `lib/tracking-status.ts` (issue #64). */
  applicationStatus: ApplicationStatus | null;
  /** The current (non-superseded) GeneratedDocument's status for the Tailored
   *  CV, or `null` when generation was never triggered — the Analyses
   *  table's "CV generated" column. */
  tailoredCvStatus: GeneratedDocumentStatus | null;
  /** Same as {@link tailoredCvStatus}, for the Cover letter. */
  coverLetterStatus: GeneratedDocumentStatus | null;
  jobOffer: {
    id: string;
    title: string | null;
    company: string | null;
    location: string | null;
    /** A `JobOfferSourceSite` enum value (e.g. `"FRANCE_TRAVAIL"`) — the
     *  Analyses table's "Plateforme" column (issue #63). */
    sourceSite: string;
    postedAt: string | null;
    /** The offer's original posting — the Analyses table's "Lien" column
     *  (issue #63) and the detail page's "Apply" action (issue #59). */
    sourceUrl: string;
  };
  cvVersion: { label: string };
  /** `{mode, siteConfigId}` of the parent IngestionJob when there is one —
   *  the Dashboard groups `mode === "SITE_SEARCH"` rows per `ingestionJobId`
   *  and resolves the site name from `siteConfigId`. */
  ingestionJob: { mode: IngestionMode; siteConfigId: string | null } | null;
};

export type AnalysisDetail = Omit<AnalysisSummary, "jobOffer"> & {
  resultJSON: AnalysisResult | null;
  errorMessage: string | null;
  jobOffer: AnalysisSummary["jobOffer"];
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

/**
 * Create one Analysis directly, without an IngestionJob (`POST /api/analyses`).
 * Used by the "Analyse one offer" known-offer shortcut (#29) — when the pasted
 * URL already resolves to a `READY` JobOffer — and by its "Re-run" action.
 * A daily-cap `429` surfaces as a {@link BffError} with `status === 429`, which
 * the screen maps to the "limit reached" message.
 */
export function useCreateAnalysis() {
  return useMutation({
    mutationFn: ({
      jobOfferId,
      cvVersionId,
    }: {
      jobOfferId: string;
      cvVersionId: string;
    }) =>
      bff.post<{ analysisId: string }>("/analyses", { jobOfferId, cvVersionId }),
  });
}

/**
 * Re-drive a stuck Analysis in place (`POST /api/analyses/{id}/requeue`,
 * docs/adr/0032) — the same row back to `PENDING`, no new Analysis and no quota
 * charged. Offered when the server reports {@link AnalysisSummary.stuck}, i.e. a
 * worker or queue restart orphaned the row.
 *
 * Distinct from {@link useCreateAnalysis}, which is the re-run of a *terminal*
 * Analysis: a brand-new row, quota charged, possibly against another CV.
 *
 * The server re-checks staleness, so a row that turns out to be alive after all
 * comes back as a {@link BffError} with `status === 409` — the screens map that
 * to "still being processed" rather than a generic failure.
 */
export function useRequeueAnalysis() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: string) =>
      bff.post<{ status: AnalysisStatus }>(`/analyses/${analysisId}/requeue`, {}),
    onSuccess: (_data, analysisId) => {
      queryClient.invalidateQueries({ queryKey: ["analyses"] });
      queryClient.invalidateQueries({ queryKey: ["analysis", analysisId] });
    },
  });
}

/**
 * Bulk "Relancer l'analyse" (issue #126): fires {@link useCreateAnalysis}'s
 * same `POST /api/analyses` call once per `{jobOfferId, cvVersionId}` pair via
 * `Promise.allSettled` — mirrors `useBulkCreateGeneratedDocuments`'s fan-out so
 * one daily-cap 429 or invalid pair doesn't abort the rest. Returns the pairs
 * that failed (by their originating Analysis id, for the partial-error count)
 * and the freshly created Analysis ids.
 */
export function useBulkCreateAnalyses() {
  return useMutation({
    mutationFn: async (
      pairs: { analysisId: string; jobOfferId: string; cvVersionId: string }[],
    ) => {
      const results = await Promise.allSettled(
        pairs.map((pair) =>
          bff.post<{ analysisId: string }>("/analyses", {
            jobOfferId: pair.jobOfferId,
            cvVersionId: pair.cvVersionId,
          }),
        ),
      );
      const failedAnalysisIds = pairs
        .filter((_, i) => results[i]!.status === "rejected")
        .map((pair) => pair.analysisId);
      const newAnalysisIds = results
        .filter(
          (result): result is PromiseFulfilledResult<{ analysisId: string }> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value.analysisId);
      return { failedAnalysisIds, newAnalysisIds };
    },
  });
}

export type KnownOfferResult =
  | { kind: "unknown" }
  | { kind: "ready"; jobOfferId: string; existingAnalysisId: string | null };

/**
 * The "Analyse one offer" known-offer shortcut (#29). Given the pasted URL and
 * the chosen CV, resolves what the screen should do on submit:
 *
 * - `unknown` — the URL is not a JobOffer we have extracted yet; the screen
 *   opens a `SINGLE_URL` IngestionJob as before.
 * - `ready` with `existingAnalysisId` — a `COMPLETED` Analysis for this exact
 *   `(JobOffer, CVVersion)` pair already exists; the screen surfaces it with a
 *   "Re-run" action instead of silently creating a duplicate.
 * - `ready` with `existingAnalysisId: null` — the offer is `READY` but not yet
 *   analysed with this CV; the screen creates the Analysis directly.
 */
export function useKnownOfferShortcut() {
  return useMutation({
    mutationFn: async ({
      url,
      cvVersionId,
    }: {
      url: string;
      cvVersionId: string;
    }): Promise<KnownOfferResult> => {
      const { jobOffer } = await bff.get<{
        jobOffer: { id: string; extractionStatus: string } | null;
      }>(`/job-offers?url=${encodeURIComponent(url)}`);
      if (!jobOffer || jobOffer.extractionStatus !== "READY") {
        return { kind: "unknown" };
      }
      const { analyses } = await bff.get<{ analyses: AnalysisDetail[] }>(
        `/analyses?jobOfferId=${encodeURIComponent(jobOffer.id)}`,
      );
      const existing = analyses.find(
        (a) => a.cvVersionId === cvVersionId && a.status === "COMPLETED",
      );
      return {
        kind: "ready",
        jobOfferId: jobOffer.id,
        existingAnalysisId: existing?.id ?? null,
      };
    },
  });
}
