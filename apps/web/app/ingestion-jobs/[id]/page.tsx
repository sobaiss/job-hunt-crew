"use client";

import { use, useCallback, useEffect, useState } from "react";

type IngestionJobStatus = "PENDING" | "RUNNING" | "PARTIALLY_COMPLETED" | "COMPLETED" | "FAILED";

type JobOfferSummary = {
  id: string;
  title: string | null;
  company: string | null;
  extractionStatus: string;
};

type IngestionJob = {
  id: string;
  mode: string;
  status: IngestionJobStatus;
  discoveredCount: number;
  scrapedCount: number;
  failedCount: number;
  errorMessage: string | null;
  jobOffers: { jobOffer: JobOfferSummary }[];
};

const TERMINAL_STATUSES: IngestionJobStatus[] = ["PARTIALLY_COMPLETED", "COMPLETED", "FAILED"];
const POLL_INTERVAL_MS = 2000;

export default function IngestionJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [ingestionJob, setIngestionJob] = useState<IngestionJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/ingestion-jobs/${id}`);
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const { ingestionJob } = await response.json();
      setIngestionJob(ingestionJob);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ingestion job");
    }
  }, [id]);

  useEffect(() => {
    // Fetching from the server on mount; not derivable from props/state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (!ingestionJob || TERMINAL_STATUSES.includes(ingestionJob.status)) {
      return;
    }
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ingestionJob, load]);

  if (error) {
    return <p role="alert">{error}</p>;
  }

  if (!ingestionJob) {
    return <p>Loading…</p>;
  }

  const processed = ingestionJob.scrapedCount + ingestionJob.failedCount;
  const total = ingestionJob.discoveredCount;

  return (
    <main>
      <h1>Ingestion Job</h1>
      <p>
        Status: <strong>{ingestionJob.status}</strong>
      </p>
      <p data-testid="ingestion-progress">
        {processed}/{total} processed
      </p>
      <p>
        Scraped: {ingestionJob.scrapedCount} · Failed: {ingestionJob.failedCount}
      </p>
      {ingestionJob.errorMessage && <p role="alert">{ingestionJob.errorMessage}</p>}
      <ul>
        {ingestionJob.jobOffers.map(({ jobOffer }) => (
          <li key={jobOffer.id}>
            {jobOffer.title ?? jobOffer.id} — {jobOffer.extractionStatus}
          </li>
        ))}
      </ul>
    </main>
  );
}
