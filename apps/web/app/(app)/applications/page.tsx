"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useApplications, APPLICATION_STATUS_VALUES, type ApplicationStatus } from "@/hooks/use-applications";
import { useScouts } from "@/hooks/use-scouts";
import { useEnumLabel } from "@/lib/enum-labels";
import { ApplicationRow } from "@/components/application-row";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

// A styled native <select>: mirrors the analyses list controls' SELECT_CLASS
// so the app reads as one system.
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The Applications tracker (issue #59, Scout slice 7): every Application the
 * Candidate has recorded — from a Scout find or a manual analysis — filtered
 * by status and Scout. Sorted newest-activity-first, the API's default order.
 */
export default function ApplicationsPage() {
  const t = useTranslations("applications");
  const statusLabel = useEnumLabel("applicationStatus");
  const [status, setStatus] = useState<ApplicationStatus | "all">("all");
  const [scoutId, setScoutId] = useState<string>("all");
  const { data: scouts } = useScouts();

  const { data: applications, isPending, isError } = useApplications({
    status: status === "all" ? undefined : status,
    scoutId: scoutId === "all" ? undefined : scoutId,
  });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{t("subtitle")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="applications-status">{t("controls.statusLabel")}</Label>
          <select
            id="applications-status"
            className={SELECT_CLASS}
            value={status}
            onChange={(event) => setStatus(event.target.value as ApplicationStatus | "all")}
          >
            <option value="all">{t("controls.statusAll")}</option>
            {APPLICATION_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="applications-scout">{t("controls.scoutLabel")}</Label>
          <select
            id="applications-scout"
            className={SELECT_CLASS}
            value={scoutId}
            onChange={(event) => setScoutId(event.target.value)}
          >
            <option value="all">{t("controls.scoutAll")}</option>
            {scouts?.map((scout) => (
              <option key={scout.id} value={scout.id}>
                {scout.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isPending && (
        <div role="status" aria-label={t("loading")} className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      )}

      {applications && applications.length === 0 && (
        <p className="text-sm text-muted">{t("empty")}</p>
      )}

      {applications && applications.length > 0 && (
        <ul className="flex flex-col gap-3">
          {applications.map((application) => (
            <li key={application.id}>
              <ApplicationRow application={application} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
