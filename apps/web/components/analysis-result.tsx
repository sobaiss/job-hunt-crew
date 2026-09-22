"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import type {
  AnalysisResult,
  ImprovementSuggestion,
  MatchedSkill,
} from "@/hooks/use-analyses";
import { cn } from "@/lib/utils";
import { MatchScoreGauge } from "@/components/match-score-gauge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

// The Match-score gauge, the five result categories and the summary, in the
// shared "Refonte" style: bordered cards laid out two-up, uppercase micro
// labels, and a colour-coded dot per skill row. Rendered by the Analysis
// detail page and, inside its Sheet, by the Quick view (#65/#70).

/** high -> medium -> low, so suggestions render most-urgent first (#45). */
const PRIORITY_RANK: Record<ImprovementSuggestion["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Matched skills beyond this rank drop their evidence quote and collapse
 *  into the compact chip row below — mirrors the reviewed mockup, which
 *  spells out the first few matches and tags the rest. */
const DETAILED_MATCH_LIMIT = 5;
/** Of those chips, only this many render by name; anything past that folds
 *  into a single "+N" chip so a long tail of matches can't push the card's
 *  height past its "Missing skills" neighbour. */
const CHIP_LIMIT = 6;

export function AnalysisResultView({ result }: { result: AnalysisResult }) {
  const t = useTranslations("analyses.detail");

  const suggestions = [...result.improvement_suggestions].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="items-center justify-center gap-4 py-10">
          <CardContent className="flex flex-col items-center gap-4 px-6">
            <h2 className="sr-only">{t("matchScore")}</h2>
            <MatchScoreGauge score={result.match_score} legend />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full flex-col gap-3">
            <SectionLabel>{t("summary")}</SectionLabel>
            <p className="font-serif text-base leading-relaxed">
              {result.summary}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-1">
            <div className="mb-1 flex items-center justify-between">
              <SectionLabel>{t("matchedSkills")}</SectionLabel>
              <Badge variant="success">{result.matched_skills.length}</Badge>
            </div>
            {result.matched_skills.length === 0 ? (
              <p className="text-sm text-muted">{t("none")}</p>
            ) : (
              <MatchedSkillsList skills={result.matched_skills} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-1">
            <div className="mb-1 flex items-center justify-between">
              <SectionLabel>{t("missingSkills")}</SectionLabel>
              <Badge variant="warning">{result.missing_skills.length}</Badge>
            </div>
            {result.missing_skills.length === 0 ? (
              <p className="text-sm text-muted">{t("none")}</p>
            ) : (
              <ul className="flex flex-col">
                {result.missing_skills.map((item, i) => {
                  const required = item.importance === "required";
                  return (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0"
                    >
                      <span className="flex items-center gap-2.5 text-sm font-medium">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 flex-none rounded-full",
                            required ? "bg-danger" : "bg-warning",
                          )}
                        />
                        {item.skill}
                      </span>
                      <Badge variant={required ? "danger" : "warning"}>
                        {t(`importance.${item.importance}`)}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-2">
            <SectionLabel>{t("strengths")}</SectionLabel>
            {result.strengths.length === 0 ? (
              <p className="text-sm text-muted">{t("none")}</p>
            ) : (
              <ul className="list-inside list-disc text-sm leading-[1.9]">
                {result.strengths.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2">
            <SectionLabel>{t("weaknesses")}</SectionLabel>
            {result.weaknesses.length === 0 ? (
              <p className="text-sm text-muted">{t("none")}</p>
            ) : (
              <ul className="list-inside list-disc text-sm leading-[1.9]">
                {result.weaknesses.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-1">
          <SectionLabel>{t("suggestions")}</SectionLabel>
          {suggestions.length === 0 ? (
            <p className="text-sm text-muted">{t("none")}</p>
          ) : (
            <ol className="mt-2 flex flex-col">
              {suggestions.map((item, i) => (
                <li
                  key={i}
                  className="flex gap-3 border-t border-border py-3"
                >
                  <PriorityTag priority={item.priority} />
                  <p className="text-sm">
                    <span className="font-medium">{item.area}</span> —{" "}
                    {item.suggestion}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Uppercase, letter-spaced micro-label shared by every card section. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-semibold tracking-[0.06em] text-muted uppercase">
      {children}
    </h2>
  );
}

/** The first {@link DETAILED_MATCH_LIMIT} matches with their evidence quote,
 *  then the rest as compact chips (capped at {@link CHIP_LIMIT}, with any
 *  remainder folded into a trailing "+N" chip). */
function MatchedSkillsList({ skills }: { skills: MatchedSkill[] }) {
  const t = useTranslations("analyses.detail");
  const detailed = skills.slice(0, DETAILED_MATCH_LIMIT);
  const rest = skills.slice(DETAILED_MATCH_LIMIT);
  const chips = rest.slice(0, CHIP_LIMIT);
  const overflow = rest.length - chips.length;

  return (
    <>
      <ul className="flex flex-col">
        {detailed.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 border-t border-border py-2.5 first:border-t-0 first:pt-0"
          >
            <span
              aria-hidden="true"
              className="mt-1.5 size-1.5 flex-none rounded-full bg-success"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.skill}</p>
              <p className="mt-0.5 text-[13px] text-muted">
                <span className="sr-only">{t("evidenceLabel")}: </span>
                {item.evidence}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {chips.length > 0 && (
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {chips.map((item, i) => (
            <Badge key={i} variant="success">
              {item.skill}
            </Badge>
          ))}
          {overflow > 0 && <Badge variant="success">+{overflow}</Badge>}
        </div>
      )}
    </>
  );
}

function PriorityTag({ priority }: { priority: ImprovementSuggestion["priority"] }) {
  const t = useTranslations("analyses.detail");
  const variant =
    priority === "high" ? "danger" : priority === "medium" ? "warning" : "muted";
  return (
    <Badge variant={variant} className="mt-0.5 flex-none self-start">
      {t(`priority.${priority}`)}
    </Badge>
  );
}
