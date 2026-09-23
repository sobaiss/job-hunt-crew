"use client";

import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// TanStack Query read hook for the job-site catalogue, layered on the typed BFF
// client (`lib/bff-client.ts`). The `/api/site-configs` contract is unchanged —
// this hook only replaces the hand-rolled `useEffect` + `fetch` that used to
// live in the SITE_SEARCH ingestion form.

export type IntegrationType = "OFFICIAL_API" | "SCRAPING";
export type AntiBotRiskLevel = "LOW" | "MEDIUM" | "HIGH";

/**
 * How faithfully one site honours one Search filter key (docs/adr/0030):
 * `SUPPORTED` — the candidate gets what they asked for; `APPROXIMATED` —
 * results outside the filter still come back; `UNSUPPORTED` — not applied.
 * Declared in services' py-db, not stored on the SiteConfig row.
 */
export type FilterSupportLevel = "SUPPORTED" | "APPROXIMATED" | "UNSUPPORTED";

/**
 * One canonical value a site treats differently from the rest of its filter,
 * with the canonical value it applies instead. A derogation only ever widens.
 */
export type Derogation = {
  level: FilterSupportLevel;
  substitute: string | null;
};

export type FilterSupport = {
  level: FilterSupportLevel;
  reason: string;
  /** Keyed by canonical value; empty on most pairs. */
  derogations?: Partial<Record<string, Derogation>>;
};

/**
 * The fields the "Analyse several offers" and Scout forms need from a
 * SiteConfig row. `/v1/site-configs` returns more (selectors, base URL, …);
 * the forms pick a site by id or key, show its `displayName`, annotate each
 * option with a reliability hint derived from `integrationType` +
 * `antiBotRiskLevel`, and warn from `filterSupport` (keyed by Search filter
 * key) which filled filters it will not honour.
 */
export type SiteConfig = {
  id: string;
  siteKey: string;
  displayName: string;
  integrationType: IntegrationType;
  antiBotRiskLevel: AntiBotRiskLevel;
  filterSupport?: Partial<Record<string, FilterSupport>>;
};

/**
 * Reliability bucket for a site, shown next to its name in the picker so the
 * candidate sets expectations: an official API is `recommended`; a `HIGH`
 * anti-bot risk `mayFail`; `MEDIUM` `mayBeUnreliable`; anything else `reliable`.
 */
export type SiteReliability =
  | "recommended"
  | "reliable"
  | "mayBeUnreliable"
  | "mayFail";

export function siteReliability(site: {
  integrationType: IntegrationType;
  antiBotRiskLevel: AntiBotRiskLevel;
}): SiteReliability {
  if (site.integrationType === "OFFICIAL_API") return "recommended";
  if (site.antiBotRiskLevel === "HIGH") return "mayFail";
  if (site.antiBotRiskLevel === "MEDIUM") return "mayBeUnreliable";
  return "reliable";
}

const SITE_CONFIGS_KEY = ["site-configs"] as const;

/** Enabled job sites, ordered by display name (ordering comes from services/api). */
export function useSiteConfigs() {
  return useQuery({
    queryKey: SITE_CONFIGS_KEY,
    queryFn: () => bff.get<{ siteConfigs: SiteConfig[] }>("/site-configs"),
    select: (data) => data.siteConfigs,
  });
}
