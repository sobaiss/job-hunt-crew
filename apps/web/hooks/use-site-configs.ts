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
 * The fields the "Analyse several offers" form needs from a SiteConfig row.
 * `/v1/site-configs` returns more (selectors, base URL, …); the form picks a
 * site by id, shows its `displayName`, and annotates each option with a
 * reliability hint derived from `integrationType` + `antiBotRiskLevel`.
 */
export type SiteConfig = {
  id: string;
  siteKey: string;
  displayName: string;
  integrationType: IntegrationType;
  antiBotRiskLevel: AntiBotRiskLevel;
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
