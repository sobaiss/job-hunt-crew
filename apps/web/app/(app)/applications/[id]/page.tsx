"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useApplication,
  useAddStatusEvent,
  APPLICATION_STATUS_VALUES,
  type ApplicationStatus,
} from "@/hooks/use-applications";
import { useEnumLabel } from "@/lib/enum-labels";
import { applicationBadgeVariant } from "@/components/application-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * An Application's detail page (issue #59): status control (moves the
 * pipeline forward, or back — "undo" is just appending a prior status),
 * the StatusEvent timeline, and back-links to its Analysis and Scout.
 */
export default function ApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("applications");
  const statusLabel = useEnumLabel("applicationStatus");
  const { data: application, isPending, isError } = useApplication(params.id);
  const addStatusEvent = useAddStatusEvent(params.id);

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <div role="status" aria-label={t("detail.loading")} className="flex flex-col gap-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </main>
    );
  }

  if (isError || !application) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("detail.loadError")}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">
          {application.jobOffer.title ?? t("list.jobOfferFallback")}
        </h1>
        {application.jobOffer.company && (
          <p className="text-sm text-muted">{application.jobOffer.company}</p>
        )}
        <p className="text-sm text-muted">{t("list.vsCv", { label: application.cvVersion.label })}</p>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href={`/analyses/${application.analysisId}`} className="text-accent hover:underline">
            {t("detail.viewAnalysis")}
          </Link>
          {application.scoutId && (
            <Link href={`/scouts/${application.scoutId}`} className="text-accent hover:underline">
              {t("detail.viewScout")}
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Badge variant={applicationBadgeVariant(application.status)}>
          {statusLabel(application.status)}
        </Badge>
        <select
          className={SELECT_CLASS + " w-auto"}
          aria-label={t("detail.moveTo")}
          value=""
          disabled={addStatusEvent.isPending}
          onChange={(event) => {
            const value = event.target.value as ApplicationStatus;
            if (value) {
              addStatusEvent.mutate({ status: value, effectiveDate: new Date().toISOString() });
            }
          }}
        >
          <option value="">{t("detail.moveTo")}</option>
          {APPLICATION_STATUS_VALUES.filter((value) => value !== application.status).map((value) => (
            <option key={value} value={value}>
              {statusLabel(value)}
            </option>
          ))}
        </select>
      </div>
      {addStatusEvent.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("detail.statusError")}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted">{t("detail.timelineHeading")}</h2>
        {application.statusEvents.length === 0 ? (
          <p className="text-sm text-muted">{t("detail.timelineEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {application.statusEvents.map((event) => (
              <li key={event.id}>
                <Card className="py-0">
                  <CardContent className="flex flex-col gap-1 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <Badge variant={applicationBadgeVariant(event.status)}>
                        {statusLabel(event.status)}
                      </Badge>
                      <span className="text-xs text-muted">
                        {new Date(event.effectiveDate).toLocaleDateString()}
                      </span>
                    </div>
                    {event.note && <p className="text-sm text-foreground">{event.note}</p>}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Button asChild variant="outline" size="sm" className="w-fit">
        <Link href="/applications">{t("detail.back")}</Link>
      </Button>
    </main>
  );
}
