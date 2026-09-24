"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";
import type { AnalysisDetail } from "@/hooks/use-analyses";
import type { ApplicationStats } from "@/hooks/use-applications";
import {
  POSTED_WITHIN_VALUES,
  REMOTE_VALUES,
  type ContractType,
  type PostedWithin,
  type Remote,
  type SiteSearchFilters,
} from "@/hooks/use-ingestion-jobs";

// TanStack Query hooks for the "Agents" area (issue #53). Scouts are saved,
// self-running search + match configs; slice 1 is CRUD only, so these hooks
// cover list / get / create / update (relabel, reconfigure, pause / resume /
// archive) against the `/api/scouts` BFF surface.

export const SCOUT_STATUS_VALUES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type ScoutStatus = (typeof SCOUT_STATUS_VALUES)[number];

/** The site keys a Scout can target — mirrors `SiteConfigSiteKey` / VALID_SITE_KEYS in services/api. */
export const SCOUT_SITE_KEYS = [
  "FRANCE_TRAVAIL",
  "LINKEDIN",
  "INDEED",
  "WTTJ",
  "GLASSDOOR",
  "HELLOWORK",
] as const;
export type ScoutSiteKey = (typeof SCOUT_SITE_KEYS)[number];

/** Default relevance threshold a new Scout starts at (mirrors services/api). */
export const DEFAULT_MATCH_THRESHOLD = 70;
/** Default "posted within" a new Scout starts at, so a daily run looks at fresh postings. */
export const DEFAULT_POSTED_WITHIN: PostedWithin = "7d";

export type ScoutFilters = {
  keywords: string | null;
  location: string | null;
  postedWithin: PostedWithin | null;
  contractType: ContractType[] | null;
  remote: Remote | null;
  experienceLevel: string | null;
};

export type ScoutRunState =
  | "IN_FLIGHT"
  | "BLOCKED"
  | "FAILED"
  | "DEGRADED"
  | "OK"
  | "NEVER_RUN";

export type Scout = {
  id: string;
  userId: string;
  label: string;
  cvVersionId: string;
  targetSiteKeys: ScoutSiteKey[];
  filters: ScoutFilters;
  matchThreshold: number;
  status: ScoutStatus;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Un-actioned relevant finds (completed Analyses with matchScore >=
   *  matchThreshold) — issue #56. Backs the Dashboard's cross-Scout count. */
  relevantFindsCount: number;
  /** Whether the Scout is working right now and, if not, whether something is
   *  wrong — derived by the server from the pipeline rows (docs/adr/0033).
   *  Read it as-is; never re-derive it from timestamps. */
  runState: ScoutRunState;
  /** The oldest clock behind the state: set for IN_FLIGHT and BLOCKED only. */
  runStateSince: string | null;
  /** Empty unless runState is BLOCKED; the ids the panel's repair re-drives. */
  blockedAnalysisIds: string[];
};

export type CreateScoutInput = {
  label: string;
  cvVersionId: string;
  targetSiteKeys: string[];
  matchThreshold: number;
  filters: SiteSearchFilters;
};

export type UpdateScoutInput = Partial<{
  label: string;
  cvVersionId: string;
  targetSiteKeys: string[];
  matchThreshold: number;
  filters: SiteSearchFilters;
  status: ScoutStatus;
}>;

export { POSTED_WITHIN_VALUES, REMOTE_VALUES };
export type { PostedWithin, Remote };

const SCOUTS_KEY = ["scouts"] as const;

/** How often the Scouts list re-reads Run state while a Scout is working —
 *  slower than the run history's 3 s, this request being the heavier one. */
export const SCOUTS_IN_FLIGHT_POLL_MS = 5000;

/**
 * Every Scout the signed-in Candidate owns, newest first.
 *
 * `pollWhileInFlight` is opt-in (issue #228): only the Scouts list renders the
 * Execution column, so only it passes the flag. The Dashboard, Applications
 * and CV versions read the same query and must not pay for a column they do
 * not show. While set, the list refetches every SCOUTS_IN_FLIGHT_POLL_MS for
 * as long as at least one Scout's Run state is IN_FLIGHT, and stops once none
 * is.
 */
export function useScouts({
  pollWhileInFlight = false,
}: { pollWhileInFlight?: boolean } = {}) {
  return useQuery({
    queryKey: SCOUTS_KEY,
    queryFn: () => bff.get<{ scouts: Scout[] }>("/scouts"),
    select: (data) => data.scouts,
    refetchInterval: pollWhileInFlight
      ? (query) => {
          const scouts = query.state.data?.scouts ?? [];
          return scouts.some((scout) => scout.runState === "IN_FLIGHT")
            ? SCOUTS_IN_FLIGHT_POLL_MS
            : false;
        }
      : false,
  });
}

/** A single Scout by id (its config summary page). */
export function useScout(id: string) {
  return useQuery({
    queryKey: [...SCOUTS_KEY, id] as const,
    queryFn: () => bff.get<{ scout: Scout }>(`/scouts/${id}`),
    select: (data) => data.scout,
    enabled: Boolean(id),
  });
}

export function useCreateScout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScoutInput) =>
      bff.post<{ scout: Scout }>("/scouts", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCOUTS_KEY });
    },
  });
}

export function useUpdateScout(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateScoutInput) =>
      bff.patch<{ scout: Scout }>(`/scouts/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCOUTS_KEY });
    },
  });
}

// --- Scout runs (issue #54, slice 2) ---
// "Run now" creates a ScoutRun that fans out to the ingestion pipeline; the
// Scout detail page polls the run history while a run is in progress.

export const SCOUT_RUN_STATUS_VALUES = [
  "PENDING",
  "RUNNING",
  "PARTIALLY_COMPLETED",
  "COMPLETED",
  "FAILED",
] as const;
export type ScoutRunStatus = (typeof SCOUT_RUN_STATUS_VALUES)[number];

export type ScoutRun = {
  id: string;
  scoutId: string;
  status: ScoutRunStatus;
  sitesQueried: number;
  siteUnavailableCount: number;
  offersDiscovered: number;
  offersAnalysed: number;
  relevantCount: number;
  failedCount: number;
  alreadySeenCount: number;
  runLimitSkippedCount: number;
  capSkippedCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

const RUN_STILL_GOING: ReadonlySet<ScoutRunStatus> = new Set([
  "PENDING",
  "RUNNING",
]);

/** A Scout's run history, newest first. Polls while any run is still going. */
export function useScoutRuns(scoutId: string) {
  return useQuery({
    queryKey: [...SCOUTS_KEY, scoutId, "runs"] as const,
    queryFn: () => bff.get<{ scoutRuns: ScoutRun[] }>(`/scouts/${scoutId}/runs`),
    select: (data) => data.scoutRuns,
    enabled: Boolean(scoutId),
    refetchInterval: (query) => {
      const runs = query.state.data?.scoutRuns ?? [];
      return runs.some((run) => RUN_STILL_GOING.has(run.status)) ? 3000 : false;
    },
  });
}

/** The Run cooldown: how long after a run's `createdAt` the API refuses the
 *  next "Run now" with a 429 — the default of `SCOUT_RUN_RATE_LIMIT_SECONDS`.
 *  The screen counts down from the same clock; the 429 stays the backstop. */
export const SCOUT_RUN_COOLDOWN_MS = 60 * 60_000;

/** "Run now": enqueues a ScoutRun. Rate-limited to once per hour per Scout (429). */
export function useRunScout(scoutId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => bff.post<{ scoutRun: ScoutRun }>(`/scouts/${scoutId}/run`),
    // The whole Scouts tree, list included: the new run makes the Run state
    // IN_FLIGHT, and the button's working face reads it from the list.
    // Awaited, so the mutation stays pending until the list has caught up
    // and the button goes straight from "Starting…" to working.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SCOUTS_KEY }),
  });
}

// --- Relevant finds (issue #56, Scout slice 4) ---
// Completed Analyses this Scout has produced, split by matchScore against
// Scout.matchThreshold into relevant finds and "found — low fit". Each row
// is the same shape `useAnalysis` returns, so the Scout panel opens the
// identical gap report a manual analysis shows.

export type ScoutFinds = {
  relevantFinds: AnalysisDetail[];
  /** Still returned by the endpoint; the Scout panel no longer shows it. */
  lowFitFinds: AnalysisDetail[];
};

export function useScoutFinds(scoutId: string) {
  return useQuery({
    queryKey: [...SCOUTS_KEY, scoutId, "finds"] as const,
    queryFn: () => bff.get<ScoutFinds>(`/scouts/${scoutId}/finds`),
    enabled: Boolean(scoutId),
  });
}

// --- Stats (issue #60, Scout slice 8) ---
// The same stats header shown on the Applications view, scoped to this
// Scout's own offers/finds/documents/applications. The "patterns across your
// matches" panel that shipped alongside it is gone from the Scout panel, and
// with it `useScoutPatterns` and its BFF route; services/api still exposes
// `/v1/scouts/{id}/patterns`, now with no web caller.

/** This Scout's stats — same shape as `useApplicationStats`, scoped to it. */
export function useScoutStats(scoutId: string) {
  return useQuery({
    queryKey: [...SCOUTS_KEY, scoutId, "stats"] as const,
    queryFn: () => bff.get<ApplicationStats>(`/scouts/${scoutId}/stats`),
    enabled: Boolean(scoutId),
  });
}
