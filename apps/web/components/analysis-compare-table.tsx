"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import type {
  AnalysisDetail,
  AnalysisResult,
  ImprovementSuggestion,
} from "@/hooks/use-analyses";
import { useEnumLabel } from "@/lib/enum-labels";
import { MatchScoreGauge } from "@/components/match-score-gauge";
import { Badge } from "@/components/ui/badge";

// The Side-by-side comparison as a table: one column per CVVersion, its
// Match-score gauge and band in the header cell, and the result categories
// aligned row-by-row so two CVs can be read line by line (#46). The gauge and
// band colours come from the shared `matchScoreBand` helper via
// `MatchScoreGauge` — `--success` / `--warning` / `--danger` only, never coral.

/** high -> medium -> low, matching the Analysis detail ordering (#45). */
const PRIORITY_RANK: Record<ImprovementSuggestion["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function statusVariant(
  status: AnalysisDetail["status"],
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PENDING" || status === "QUEUED") return "secondary";
  return "warning";
}

export function AnalysisCompareTable({
  columns,
}: {
  columns: AnalysisDetail[];
}) {
  const t = useTranslations("analyses");
  const td = useTranslations("analyses.detail");
  const statusLabel = useEnumLabel("analysisStatus");

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              className="w-40 border-b border-border p-3 text-left align-bottom text-xs font-semibold text-muted"
            >
              {t("compare.category")}
            </th>
            {columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                className="min-w-64 border-b border-border p-3 text-center align-bottom"
              >
                <div className="flex flex-col items-center gap-2">
                  <span className="font-serif text-base font-semibold">
                    {col.cvVersion.label}
                  </span>
                  <Badge variant={statusVariant(col.status)}>
                    {statusLabel(col.status)}
                  </Badge>
                  {col.resultJSON ? (
                    <MatchScoreGauge score={col.resultJSON.match_score} />
                  ) : (
                    <span className="text-xs text-muted">
                      {t("compare.noResult")}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <CategoryRow label={td("matchedSkills")} columns={columns}>
            {(result) =>
              result.matched_skills.length === 0 ? (
                <Empty label={td("none")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {result.matched_skills.map((item, i) => (
                    <li
                      key={i}
                      className="rounded-md border border-border bg-panel/40 p-2"
                    >
                      <span className="font-medium">{item.skill}</span>
                      <span className="mt-1 block text-muted">
                        <span className="font-medium">
                          {td("evidenceLabel")}:
                        </span>{" "}
                        {item.evidence}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </CategoryRow>

          <CategoryRow label={td("missingSkills")} columns={columns}>
            {(result) =>
              result.missing_skills.length === 0 ? (
                <Empty label={td("none")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {result.missing_skills.map((item, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="font-medium">{item.skill}</span>
                      <Badge
                        variant={
                          item.importance === "required"
                            ? "warning"
                            : "secondary"
                        }
                      >
                        {td(`importance.${item.importance}`)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )
            }
          </CategoryRow>

          <CategoryRow label={td("strengths")} columns={columns}>
            {(result) => <BulletList items={result.strengths} empty={td("none")} />}
          </CategoryRow>

          <CategoryRow label={td("weaknesses")} columns={columns}>
            {(result) => (
              <BulletList items={result.weaknesses} empty={td("none")} />
            )}
          </CategoryRow>

          <CategoryRow label={td("suggestions")} columns={columns}>
            {(result) => {
              const sorted = [...result.improvement_suggestions].sort(
                (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
              );
              return sorted.length === 0 ? (
                <Empty label={td("none")} />
              ) : (
                <ol className="flex flex-col gap-2">
                  {sorted.map((item, i) => (
                    <li
                      key={i}
                      className="flex flex-col gap-1 rounded-md border border-border p-2"
                    >
                      <Badge
                        variant={
                          item.priority === "high" ? "warning" : "secondary"
                        }
                        className="self-start"
                      >
                        {td(`priority.${item.priority}`)}
                      </Badge>
                      <span>
                        <span className="font-medium">{item.area}</span>:{" "}
                        {item.suggestion}
                      </span>
                    </li>
                  ))}
                </ol>
              );
            }}
          </CategoryRow>

          <CategoryRow label={td("summary")} columns={columns}>
            {(result) => (
              <p className="font-serif leading-relaxed">{result.summary}</p>
            )}
          </CategoryRow>
        </tbody>
      </table>
    </div>
  );
}

function CategoryRow({
  label,
  columns,
  children,
}: {
  label: string;
  columns: AnalysisDetail[];
  children: (result: AnalysisResult) => ReactNode;
}) {
  const t = useTranslations("analyses");
  return (
    <tr className="border-b border-border align-top">
      <th
        scope="row"
        className="p-3 text-left text-xs font-semibold text-muted"
      >
        {label}
      </th>
      {columns.map((col) => (
        <td key={col.id} className="p-3">
          {col.resultJSON ? (
            children(col.resultJSON)
          ) : (
            <Empty label={t("compare.noResult")} />
          )}
        </td>
      ))}
    </tr>
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Empty label={empty} />;
  return (
    <ul className="list-inside list-disc">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Empty({ label }: { label: string }) {
  return <span className="text-muted">{label}</span>;
}
