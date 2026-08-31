"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// TanStack Query read hook + create mutation for the ingestion area, layered on
// the typed BFF client (`lib/bff-client.ts`). The `/api/*` contract is
// unchanged — these hooks only move the fetching, and the hand-rolled
// `useEffect` + `setInterval` polling that used to live in the detail page.

export type IngestionJobStatus =
  | "PENDING"
  | "RUNNING"
  | "PARTIALLY_COMPLETED"
  | "COMPLETED"
  | "FAILED";

/** Once an IngestionJob reaches one of these, the detail page stops polling. */
export const TERMINAL_INGESTION_STATUSES: ReadonlySet<IngestionJobStatus> =
  new Set(["PARTIALLY_COMPLETED", "COMPLETED", "FAILED"]);

/** Detail poll cadence, preserved from the previous hand-rolled polling. */
export const INGESTION_POLL_INTERVAL_MS = 2000;

/**
 * Machine-readable prefix the SINGLE_URL pipeline puts on
 * `IngestionJob.errorMessage` when the pasted page turned out to be a
 * listing / search-results page rather than one offer (see
 * `LISTING_PAGE_ERROR_MESSAGE` in `services/ingestion`). Lets the "Analyse one
 * offer" screen show the "looks like a listing" redirect instead of the
 * generic fetch-failure message.
 */
export const LISTING_PAGE_ERROR_PREFIX = "LISTING_PAGE_DETECTED";

/** True when a failed IngestionJob failed because its input was a listing page. */
export function isListingPageError(
  errorMessage: string | null | undefined,
): boolean {
  return errorMessage?.startsWith(LISTING_PAGE_ERROR_PREFIX) ?? false;
}

/**
 * Filter values services/api accepts for a SITE_SEARCH job. Mirrors
 * `POSTED_WITHIN_VALUES` / `REMOTE_VALUES` in `services/api/src/api/v1.py`; the
 * form validates against these so a bad value is rejected before the request.
 */
export const POSTED_WITHIN_VALUES = ["24h", "7d", "14d", "30d", "any"] as const;
export const REMOTE_VALUES = ["onsite", "hybrid", "remote"] as const;

export type PostedWithin = (typeof POSTED_WITHIN_VALUES)[number];
export type Remote = (typeof REMOTE_VALUES)[number];

export type SiteSearchFilters = {
  keywords?: string;
  location?: string;
  postedWithin?: PostedWithin;
  contractType?: string;
  remote?: Remote;
  experienceLevel?: string;
};

type JobOfferSummary = {
  id: string;
  title: string | null;
  company: string | null;
  extractionStatus: string;
};

export type IngestionJob = {
  id: string;
  mode: string;
  status: IngestionJobStatus;
  discoveredCount: number;
  scrapedCount: number;
  failedCount: number;
  errorMessage: string | null;
};

export type IngestionJobDetail = IngestionJob & {
  jobOffers: { jobOffer: JobOfferSummary }[];
};

/**
 * One IngestionJob. Polls every {@link INGESTION_POLL_INTERVAL_MS} while the
 * status is non-terminal and stops once it is `PARTIALLY_COMPLETED`,
 * `COMPLETED` or `FAILED`.
 */
export function useIngestionJob(id: string) {
  return useQuery({
    queryKey: ["ingestion-job", id],
    queryFn: () =>
      bff.get<{ ingestionJob: IngestionJobDetail }>(`/ingestion-jobs/${id}`),
    select: (data) => data.ingestionJob,
    refetchInterval: (query) => {
      const status = query.state.data?.ingestionJob.status;
      return status && TERMINAL_INGESTION_STATUSES.has(status)
        ? false
        : INGESTION_POLL_INTERVAL_MS;
    },
  });
}

/**
 * Create a SITE_SEARCH IngestionJob. There is no ingestion-jobs list to
 * invalidate; the caller links straight to the new job's detail page.
 */
export function useCreateIngestionJob() {
  return useMutation({
    mutationFn: ({
      siteConfigId,
      filters,
    }: {
      siteConfigId: string;
      filters: SiteSearchFilters;
    }) =>
      bff.post<{ ingestionJob: IngestionJob }>("/ingestion-jobs", {
        mode: "SITE_SEARCH",
        siteConfigId,
        filters,
      }),
  });
}

/**
 * Create a SINGLE_URL IngestionJob from a pasted offer URL and the chosen
 * CVVersion. The worker scrapes/extracts that one offer and then creates the
 * Analysis; the "Analyse one offer" screen polls for that Analysis and routes
 * to its detail view. services/api forces `maxOffers = 1` for this mode.
 */
export function useCreateSingleUrlIngestionJob() {
  return useMutation({
    mutationFn: ({
      inputUrl,
      cvVersionId,
    }: {
      inputUrl: string;
      cvVersionId: string;
    }) =>
      bff.post<{ ingestionJob: IngestionJob }>("/ingestion-jobs", {
        mode: "SINGLE_URL",
        inputUrl,
        cvVersionId,
      }),
  });
}
