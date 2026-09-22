"use client";

import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";

import { useScoutFinds } from "@/hooks/use-scouts";
import { AnalysisRow } from "@/components/analysis-row";
import { PanelEmptyState, PanelSection } from "@/components/panel-section";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A Scout's relevant finds — extracted from the former `/scouts/[id]` detail
 * page so the Scout panel can absorb it (issue #92, superseding
 * docs/adr/0006 — see docs/adr/0007-scout-panel-full-absorption.md).
 *
 * Only the relevant ones: the "found — low fit" list the endpoint also
 * returns is no longer surfaced. Everything below the Scout's own threshold
 * is, by that Scout's definition, not what the candidate asked to be shown.
 */
export function ScoutFinds({ scoutId }: { scoutId: string }) {
  const t = useTranslations("scouts.finds");
  const { data, isPending, isError } = useScoutFinds(scoutId);

  return (
    <PanelSection
      icon={Sparkles}
      title={t("relevantHeading")}
      trailing={
        data && data.relevantFinds.length > 0 ? (
          <Badge variant="muted" className="tabular-nums">
            {data.relevantFinds.length}
          </Badge>
        ) : null
      }
    >
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError || !data ? (
        <p role="alert" className="text-destructive">
          {t("loadError")}
        </p>
      ) : data.relevantFinds.length === 0 ? (
        <PanelEmptyState icon={Sparkles}>{t("relevantEmpty")}</PanelEmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.relevantFinds.map((analysis) => (
            <li key={analysis.id}>
              <AnalysisRow analysis={analysis} />
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
