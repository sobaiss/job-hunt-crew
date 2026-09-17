"use client";

import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";

import { useQuotas, useMarkQuotaAlertRead, type QuotaKindName } from "@/hooks/use-quotas";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// The persisted notification feed for QuotaAlerts (issue #142): unlike a
// toast, unread alerts stay here until dismissed, so a Candidate who
// navigates away before noticing one doesn't lose it. Mounted once in
// AppTopbar so it's reachable from every signed-in page.

const QUOTA_KIND_NAME: Record<string, QuotaKindName> = {
  ACTIVE_SCOUTS: "activeScouts",
  ANALYSES_DAILY: "analysesDaily",
  ANALYSES_MONTHLY: "analysesMonthly",
  DOCUMENTS_DAILY: "documentsDaily",
};

export function QuotaAlertsFeed() {
  const t = useTranslations("quotaAlerts");
  const tKinds = useTranslations("quotas.kinds");
  const { data } = useQuotas();
  const markRead = useMarkQuotaAlertRead();

  const alerts = data?.alerts ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("label")} className="relative">
          <Bell className="size-4" aria-hidden="true" />
          {alerts.length > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 flex size-2 rounded-full bg-destructive"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{t("label")}</span>
          {alerts.length > 0 && (
            <span className="text-xs font-normal text-muted">
              {t("unread", { count: alerts.length })}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {alerts.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1 p-1">
            {alerts.map((alert) => {
              const kind = QUOTA_KIND_NAME[alert.quotaKind] ?? alert.quotaKind;
              const message = t(alert.threshold === "EXCEEDED" ? "exceeded" : "approaching", {
                kind: tKinds(kind),
              });
              return (
                <li
                  key={alert.id}
                  className="flex items-start justify-between gap-2 rounded-md p-2 text-sm"
                >
                  <span>{message}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto flex-none px-1.5 py-0.5 text-xs"
                    disabled={markRead.isPending}
                    onClick={() => markRead.mutate(alert.id)}
                  >
                    {t("dismiss")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
