"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";
import {
  POSTED_WITHIN_VALUES,
  REMOTE_VALUES,
  type PostedWithin,
  type Remote,
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
  contractType: string | null;
  remote: Remote | null;
  experienceLevel: string | null;
};

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
};

export type CreateScoutInput = {
  label: string;
  cvVersionId: string;
  targetSiteKeys: string[];
  matchThreshold: number;
  filters: Partial<Record<keyof ScoutFilters, string | undefined>>;
};

export type UpdateScoutInput = Partial<{
  label: string;
  cvVersionId: string;
  targetSiteKeys: string[];
  matchThreshold: number;
  filters: Partial<Record<keyof ScoutFilters, string | undefined>>;
  status: ScoutStatus;
}>;

export { POSTED_WITHIN_VALUES, REMOTE_VALUES };
export type { PostedWithin, Remote };

const SCOUTS_KEY = ["scouts"] as const;

/** Every Scout the signed-in Candidate owns, newest first. */
export function useScouts() {
  return useQuery({
    queryKey: SCOUTS_KEY,
    queryFn: () => bff.get<{ scouts: Scout[] }>("/scouts"),
    select: (data) => data.scouts,
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
