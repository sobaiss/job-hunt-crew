"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

const POLL_INTERVAL_MS = 3000;
const SOFT_TIMEOUT_MS = 2 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

type MatchedSkill = { skill: string; evidence: string };
type MissingSkill = { skill: string; importance: "required" | "nice_to_have" };
type ImprovementSuggestion = {
  area: string;
  suggestion: string;
  priority: "high" | "medium" | "low";
};

type AnalysisResult = {
  match_score: number;
  matched_skills: MatchedSkill[];
  missing_skills: MissingSkill[];
  strengths: string[];
  weaknesses: string[];
  improvement_suggestions: ImprovementSuggestion[];
  summary: string;
  generated_at: string;
  model_used: string;
};

type Analysis = {
  id: string;
  status: "PENDING" | "QUEUED" | "RUNNING_CREW" | "AWAITING_RESULT" | "PERSISTING" | "COMPLETED" | "FAILED";
  matchScore: number | null;
  resultJSON: AnalysisResult | null;
  errorMessage: string | null;
  jobOffer: { title: string | null; company: string | null };
  cvVersion: { label: string };
};

export default function AnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const startedAtRef = useRef<number | null>(null);

  const loadAnalysis = useCallback(async () => {
    try {
      const response = await fetch(`/api/analyses/${params.id}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed with ${response.status}`);
      }
      const { analysis } = await response.json();
      setAnalysis(analysis);
      setError(null);
      return analysis as Analysis;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analysis");
      return null;
    }
  }, [params.id]);

  useEffect(() => {
    startedAtRef.current = Date.now();
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      const result = await loadAnalysis();
      if (cancelled) return;

      if (result && TERMINAL_STATUSES.has(result.status)) {
        if (intervalId) clearInterval(intervalId);
        return;
      }

      if (startedAtRef.current !== null && Date.now() - startedAtRef.current >= SOFT_TIMEOUT_MS) {
        setTimedOut(true);
      }
    };

    tick();
    intervalId = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [loadAnalysis]);

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-16">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="mx-auto max-w-2xl p-16">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  const result = analysis.resultJSON;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-16">
      <div>
        <h1 className="text-2xl font-semibold">
          {analysis.jobOffer.title ?? "Job offer"} {analysis.jobOffer.company ? `— ${analysis.jobOffer.company}` : ""}
        </h1>
        <p className="text-sm text-zinc-500">
          vs. {analysis.cvVersion.label} · Status: {analysis.status}
        </p>
      </div>

      {analysis.status === "FAILED" && (
        <p className="text-sm text-red-600">{analysis.errorMessage ?? "Analysis failed."}</p>
      )}

      {timedOut && !TERMINAL_STATUSES.has(analysis.status) && (
        <p className="text-sm text-amber-600">
          This is taking longer than expected (over 2 minutes). Still checking for a result…
        </p>
      )}

      {!result ? (
        <p className="text-sm text-zinc-500">No result yet.</p>
      ) : (
        <>
          <section>
            <h2 className="text-lg font-semibold">Match score</h2>
            <p className="text-3xl font-bold">{result.match_score}</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">Matched skills</h2>
            {result.matched_skills.length === 0 ? (
              <p className="text-sm text-zinc-500">None.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {result.matched_skills.map((item, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium">{item.skill}</span> — {item.evidence}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold">Missing skills</h2>
            {result.missing_skills.length === 0 ? (
              <p className="text-sm text-zinc-500">None.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {result.missing_skills.map((item, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium">{item.skill}</span> ({item.importance})
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold">Strengths</h2>
            <ul className="list-inside list-disc text-sm">
              {result.strengths.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">Weaknesses</h2>
            <ul className="list-inside list-disc text-sm">
              {result.weaknesses.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">Improvement suggestions</h2>
            <ul className="flex flex-col gap-1">
              {result.improvement_suggestions.map((item, i) => (
                <li key={i} className="text-sm">
                  <span className="font-medium">[{item.priority}]</span> {item.area}: {item.suggestion}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold">Summary</h2>
            <p className="text-sm">{result.summary}</p>
          </section>
        </>
      )}
    </div>
  );
}
