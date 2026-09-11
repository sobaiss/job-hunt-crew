"use client";

import { useTranslations } from "next-intl";

import { useScoutPatterns } from "@/hooks/use-scouts";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * "Patterns across your matches" (issue #60): the skills most often required
 * by this Scout's relevant finds and missing from the base CV, ranked by
 * frequency. Updates as new finds accumulate — it's just a read of the
 * current completed-Analysis set, no caching beyond the query itself.
 */
export function ScoutPatternsPanel({ scoutId }: { scoutId: string }) {
  const t = useTranslations("scouts.patterns");
  const { data: patterns, isPending, isError } = useScoutPatterns(scoutId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-6 text-sm">
        <h2 className="font-serif text-lg font-semibold">{t("heading")}</h2>
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : isError || !patterns ? (
          <p role="alert" className="text-destructive">
            {t("loadError")}
          </p>
        ) : patterns.length === 0 ? (
          <p className="text-muted">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {patterns.map((pattern) => (
              <li key={pattern.skill} className="flex items-center justify-between gap-4">
                <span>{pattern.skill}</span>
                <span className="text-muted">{t("count", { count: pattern.count })}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
