"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

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
};

type Analysis = {
  id: string;
  status: "PENDING" | "QUEUED" | "RUNNING_CREW" | "AWAITING_RESULT" | "PERSISTING" | "COMPLETED" | "FAILED";
  matchScore: number | null;
  resultJSON: AnalysisResult | null;
  jobOffer: { title: string | null; company: string | null };
  cvVersion: { label: string };
};

export default function CompareAnalysesPage() {
  const params = useParams<{ jobOfferId: string }>();
  const [analyses, setAnalyses] = useState<Analysis[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(`/api/analyses?jobOfferId=${params.jobOfferId}`);
        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }
        const { analyses } = await response.json();
        setAnalyses(analyses);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load analyses");
      }
    })();
  }, [params.jobOfferId]);

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-16">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (!analyses) {
    return (
      <div className="mx-auto max-w-2xl p-16">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (analyses.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-16">
        <p className="text-sm text-zinc-500">No analyses found for this job offer.</p>
      </div>
    );
  }

  const offer = analyses[0].jobOffer;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-16">
      <div>
        <h1 className="text-2xl font-semibold">
          {offer.title ?? "Job offer"} {offer.company ? `— ${offer.company}` : ""}
        </h1>
        <p className="text-sm text-zinc-500">Comparing {analyses.length} CV version(s)</p>
      </div>

      {analyses.length < 2 && (
        <p className="text-sm text-amber-600">
          Only one analysis exists for this offer — request an analysis against another CV version to compare.
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {analyses.map((analysis) => {
          const result = analysis.resultJSON;
          return (
            <div key={analysis.id} className="flex flex-col gap-4 rounded border border-zinc-300 p-4">
              <div>
                <h2 className="font-semibold">{analysis.cvVersion.label}</h2>
                <p className="text-xs text-zinc-500">Status: {analysis.status}</p>
              </div>

              {!result ? (
                <p className="text-sm text-zinc-500">No result yet.</p>
              ) : (
                <>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Match score</h3>
                    <p className="text-2xl font-bold">{result.match_score}</p>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Matched skills</h3>
                    <ul className="flex flex-col gap-1">
                      {result.matched_skills.map((item, i) => (
                        <li key={i} className="text-sm">
                          {item.skill}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Missing skills</h3>
                    <ul className="flex flex-col gap-1">
                      {result.missing_skills.map((item, i) => (
                        <li key={i} className="text-sm">
                          {item.skill} ({item.importance})
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Strengths</h3>
                    <ul className="list-inside list-disc text-sm">
                      {result.strengths.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Weaknesses</h3>
                    <ul className="list-inside list-disc text-sm">
                      {result.weaknesses.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Suggestions</h3>
                    <ul className="flex flex-col gap-1">
                      {result.improvement_suggestions.map((item, i) => (
                        <li key={i} className="text-sm">
                          <span className="font-medium">[{item.priority}]</span> {item.area}: {item.suggestion}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-500">Summary</h3>
                    <p className="text-sm">{result.summary}</p>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
