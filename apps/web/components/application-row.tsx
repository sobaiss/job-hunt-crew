"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import type { Application, ApplicationStatus } from "@/hooks/use-applications";
import { useEnumLabel } from "@/lib/enum-labels";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export function applicationBadgeVariant(
  status: ApplicationStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACCEPTED" || status === "OFFER") return "success";
  if (status === "REJECTED" || status === "WITHDRAWN") return "destructive";
  if (status === "DRAFT") return "secondary";
  return "warning";
}

/**
 * One Application as a card row on the Applications tracker (issue #59):
 * offer, CV version used, status badge, and the date it last moved, linking
 * to the Application's detail/timeline page.
 */
export function ApplicationRow({ application }: { application: Application }) {
  const t = useTranslations("applications");
  const statusLabel = useEnumLabel("applicationStatus");

  return (
    <Card className="py-0 transition-colors hover:bg-panel">
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <Link href={`/applications/${application.id}`} className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {application.jobOffer.title ?? t("list.jobOfferFallback")}
          </span>
          {application.jobOffer.company && (
            <span className="truncate text-sm text-muted">{application.jobOffer.company}</span>
          )}
          <span className="text-xs text-muted">
            {t("list.vsCv", { label: application.cvVersion.label })} ·{" "}
            {t("list.updated", { date: new Date(application.updatedAt).toLocaleDateString() })}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-3">
          {application.scoutId && <Badge variant="secondary">{t("list.scoutTag")}</Badge>}
          <Badge variant={applicationBadgeVariant(application.status)}>
            {statusLabel(application.status)}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
