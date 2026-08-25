"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Analysis = {
  id: string;
  status: "PENDING" | "QUEUED" | "RUNNING_CREW" | "AWAITING_RESULT" | "PERSISTING" | "COMPLETED" | "FAILED";
  matchScore: number | null;
  requestedAt: string;
  jobOffer: { title: string | null; company: string | null };
  cvVersion: { label: string };
};

const STATUS_STYLES: Record<Analysis["status"], string> = {
  PENDING: "bg-zinc-100 text-zinc-700",
  QUEUED: "bg-zinc-100 text-zinc-700",
  RUNNING_CREW: "bg-amber-100 text-amber-700",
  AWAITING_RESULT: "bg-amber-100 text-amber-700",
  PERSISTING: "bg-amber-100 text-amber-700",
  COMPLETED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
};

export default function AnalysesDashboardPage() {
  const [analyses, setAnalyses] = useState<Analysis[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/analyses");
        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }
        const { analyses } = await response.json();
        setAnalyses(analyses);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load analyses");
      }
    })();
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-16">
      <h1 className="text-2xl font-semibold">Your analyses</h1>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!error && !analyses && <p className="text-sm text-zinc-500">Loading…</p>}

      {analyses && analyses.length === 0 && (
        <p className="text-sm text-zinc-500">No analyses requested yet.</p>
      )}

      {analyses && analyses.length > 0 && (
        <ul className="flex flex-col gap-3">
          {analyses.map((analysis) => (
            <li key={analysis.id}>
              <Link
                href={`/analyses/${analysis.id}`}
                className="flex items-center justify-between gap-4 rounded border border-zinc-300 px-3 py-2 hover:bg-zinc-50"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {analysis.jobOffer.title ?? "Job offer"}
                    {analysis.jobOffer.company ? ` — ${analysis.jobOffer.company}` : ""}
                  </span>
                  <span className="text-xs text-zinc-500">vs. {analysis.cvVersion.label}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {analysis.matchScore !== null && (
                    <span className="text-sm font-semibold">{analysis.matchScore}</span>
                  )}
                  <span
                    className={`rounded px-2 py-1 text-xs font-medium ${STATUS_STYLES[analysis.status]}`}
                  >
                    {analysis.status}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
