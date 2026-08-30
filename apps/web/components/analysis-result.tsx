"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { AnalysisResult } from "@/hooks/use-analyses";

// The five result categories plus the score and summary, in the shared style.
// Rendered by the analysis detail page and (ticket #10) by each column of the
// Side-by-side comparison.
export function AnalysisResultView({ result }: { result: AnalysisResult }) {
  const t = useTranslations("analyses.detail");

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-muted">{t("matchScore")}</h2>
        <p className="text-4xl font-bold tabular-nums">{result.match_score}</p>
      </section>

      <ResultSection
        title={t("matchedSkills")}
        empty={result.matched_skills.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="flex flex-col gap-1">
          {result.matched_skills.map((item, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">{item.skill}</span> — {item.evidence}
            </li>
          ))}
        </ul>
      </ResultSection>

      <ResultSection
        title={t("missingSkills")}
        empty={result.missing_skills.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="flex flex-col gap-1">
          {result.missing_skills.map((item, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">{item.skill}</span> ({item.importance})
            </li>
          ))}
        </ul>
      </ResultSection>

      <ResultSection
        title={t("strengths")}
        empty={result.strengths.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="list-inside list-disc text-sm">
          {result.strengths.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </ResultSection>

      <ResultSection
        title={t("weaknesses")}
        empty={result.weaknesses.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="list-inside list-disc text-sm">
          {result.weaknesses.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </ResultSection>

      <ResultSection
        title={t("suggestions")}
        empty={result.improvement_suggestions.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="flex flex-col gap-1">
          {result.improvement_suggestions.map((item, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">[{item.priority}]</span> {item.area}:{" "}
              {item.suggestion}
            </li>
          ))}
        </ul>
      </ResultSection>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-muted">{t("summary")}</h2>
        <p className="font-serif text-sm leading-relaxed">{result.summary}</p>
      </section>
    </div>
  );
}

function ResultSection({
  title,
  empty,
  emptyLabel,
  children,
}: {
  title: string;
  empty: boolean;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted">{title}</h2>
      {empty ? <p className="text-sm text-muted">{emptyLabel}</p> : children}
    </section>
  );
}
