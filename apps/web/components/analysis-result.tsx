"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import type {
  AnalysisResult,
  ImprovementSuggestion,
} from "@/hooks/use-analyses";
import { MatchScoreGauge } from "@/components/match-score-gauge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

// The Match-score gauge, the five result categories and the summary, in the
// shared style. Rendered by the Analysis detail page and by each column of the
// Side-by-side comparison (#46).

/** high -> medium -> low, so suggestions render most-urgent first (#45). */
const PRIORITY_RANK: Record<ImprovementSuggestion["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function AnalysisResultView({ result }: { result: AnalysisResult }) {
  const t = useTranslations("analyses.detail");

  const suggestions = [...result.improvement_suggestions].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted">{t("matchScore")}</h2>
        <MatchScoreGauge score={result.match_score} />
      </section>

      <ResultSection
        title={t("matchedSkills")}
        empty={result.matched_skills.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="flex flex-col gap-2">
          {result.matched_skills.map((item, i) => (
            <li
              key={i}
              className="rounded-md border border-border bg-panel/40 p-3 text-sm"
            >
              <span className="font-medium">{item.skill}</span>
              <span className="mt-1 block text-muted">
                <span className="font-medium">{t("evidenceLabel")}:</span>{" "}
                {item.evidence}
              </span>
            </li>
          ))}
        </ul>
      </ResultSection>

      <ResultSection
        title={t("missingSkills")}
        empty={result.missing_skills.length === 0}
        emptyLabel={t("none")}
      >
        <ul className="flex flex-col gap-2">
          {result.missing_skills.map((item, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="font-medium">{item.skill}</span>
              <Badge
                variant={
                  item.importance === "required" ? "warning" : "secondary"
                }
              >
                {t(`importance.${item.importance}`)}
              </Badge>
            </li>
          ))}
        </ul>
      </ResultSection>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-muted">
              {t("strengths")}
            </h2>
            {result.strengths.length === 0 ? (
              <p className="text-sm text-muted">{t("none")}</p>
            ) : (
              <ul className="list-inside list-disc text-sm">
                {result.strengths.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-muted">
              {t("weaknesses")}
            </h2>
            {result.weaknesses.length === 0 ? (
              <p className="text-sm text-muted">{t("none")}</p>
            ) : (
              <ul className="list-inside list-disc text-sm">
                {result.weaknesses.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <ResultSection
        title={t("suggestions")}
        empty={suggestions.length === 0}
        emptyLabel={t("none")}
      >
        <ol className="flex flex-col gap-2">
          {suggestions.map((item, i) => (
            <li
              key={i}
              className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm"
            >
              <Badge
                variant={item.priority === "high" ? "warning" : "secondary"}
                className="self-start"
              >
                {t(`priority.${item.priority}`)}
              </Badge>
              <span>
                <span className="font-medium">{item.area}</span>:{" "}
                {item.suggestion}
              </span>
            </li>
          ))}
        </ol>
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
