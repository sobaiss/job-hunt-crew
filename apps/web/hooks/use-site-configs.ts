"use client";

import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// TanStack Query read hook for the job-site catalogue, layered on the typed BFF
// client (`lib/bff-client.ts`). The `/api/site-configs` contract is unchanged —
// this hook only replaces the hand-rolled `useEffect` + `fetch` that used to
// live in the SITE_SEARCH ingestion form.

/**
 * The fields the ingestion form needs from a SiteConfig row. `/v1/site-configs`
 * returns more (selectors, integration type, …); the form only picks a site by
 * id and shows its `displayName`.
 */
export type SiteConfig = {
  id: string;
  siteKey: string;
  displayName: string;
};

const SITE_CONFIGS_KEY = ["site-configs"] as const;

/** Enabled job sites, ordered by display name (ordering comes from services/api). */
export function useSiteConfigs() {
  return useQuery({
    queryKey: SITE_CONFIGS_KEY,
    queryFn: () => bff.get<{ siteConfigs: SiteConfig[] }>("/site-configs"),
    select: (data) => data.siteConfigs,
  });
}
