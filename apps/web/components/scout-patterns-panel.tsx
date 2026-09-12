"use client";

import { useTranslations } from "next-intl";

import { useScoutPatterns } from "@/hooks/use-scouts";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * "Patterns across your matches" (issue #60): the skills most often required
 * by this Scout's relevant finds and missing from the base CV, plus the
 * weaknesses that keep recurring, both ranked by frequency. Updates as new
 * finds accumulate — it's just a read of the current completed-Analysis
 * set, no caching beyond the query itself.
 */
export function ScoutPatternsPanel({ scoutId }: { scoutId: string }) {
  const t = useTranslations("scouts.patterns");
  const { data, isPending, isError } = useScoutPatterns(scoutId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 py-6 text-sm">
        <div className="flex flex-col gap-3">
          <h2 className="font-serif text-lg font-semibold">{t("heading")}</h2>
          {isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : isError || !data ? (
            <p role="alert" className="text-destructive">
              {t("loadError")}
            </p>
          ) : data.patterns.length === 0 ? (
            <p className="text-muted">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.patterns.map((pattern) => (
                <li key={pattern.skill} className="flex items-center justify-between gap-4">
                  <span>{pattern.skill}</span>
                  <span className="text-muted">{t("count", { count: pattern.count })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!isPending && !isError && data ? (
          <div className="flex flex-col gap-3">
            <h3 className="font-serif text-base font-semibold">{t("weaknessesHeading")}</h3>
            {data.weaknesses.length === 0 ? (
              <p className="text-muted">{t("weaknessesEmpty")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.weaknesses.map((weakness) => (
                  <li
                    key={weakness.weakness}
                    className="flex items-center justify-between gap-4"
                  >
                    <span>{weakness.weakness}</span>
                    <span className="text-muted">{t("count", { count: weakness.count })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
