"use client";

import { useTranslations } from "next-intl";

import { useScoutFinds } from "@/hooks/use-scouts";
import { AnalysisRow } from "@/components/analysis-row";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A Scout's relevant / low-fit finds — extracted from the former
 * `/scouts/[id]` detail page so the Scout panel can absorb it (issue #92,
 * superseding docs/adr/0006 — see docs/adr/0007-scout-panel-full-absorption.md).
 */
export function ScoutFinds({ scoutId }: { scoutId: string }) {
  const t = useTranslations("scouts.finds");
  const { data, isPending, isError } = useScoutFinds(scoutId);

  if (isPending) {
    return <Skeleton className="h-16 w-full" />;
  }

  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-3 py-6 text-sm">
          <h2 className="font-serif text-lg font-semibold">
            {t("relevantHeading")}
          </h2>
          {data.relevantFinds.length === 0 ? (
            <p className="text-muted">{t("relevantEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.relevantFinds.map((analysis) => (
                <li key={analysis.id}>
                  <AnalysisRow analysis={analysis} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data.lowFitFinds.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-6 text-sm">
            <h2 className="font-serif text-lg font-semibold">
              {t("lowFitHeading")}
            </h2>
            <ul className="flex flex-col gap-3">
              {data.lowFitFinds.map((analysis) => (
                <li key={analysis.id}>
                  <AnalysisRow analysis={analysis} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
