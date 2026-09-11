"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { useMarkAsApplied } from "@/hooks/use-applications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// "Mark as applied" on a completed Analysis (issue #59, Scout slice 7):
// records an Application at APPLIED without generating documents first. The
// full "Apply" composition (open the posting in a new tab + download the
// document package) is deferred — it needs the PDF-on-demand endpoint,
// which #58 also deferred.
export function ApplicationAction({ analysisId }: { analysisId: string }) {
  const t = useTranslations("analyses.detail.application");
  const markAsApplied = useMarkAsApplied();

  if (markAsApplied.data) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="success">{t("applied")}</Badge>
        <Link
          href={`/applications/${markAsApplied.data.application.id}`}
          className="text-accent hover:underline"
        >
          {t("viewApplication")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => markAsApplied.mutate(analysisId)}
        disabled={markAsApplied.isPending}
      >
        {t("markApplied")}
      </Button>
      {markAsApplied.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("markAppliedError")}
        </p>
      )}
    </div>
  );
}
