"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight, ChevronLeft, ChevronRight, ExternalLink, FileText, X } from "lucide-react";

import { useAddStatusEvent, useApplication } from "@/hooks/use-applications";
import type { ApplicationSummary } from "@/lib/applications-filters";
import { useEnumLabel } from "@/lib/enum-labels";
import {
  TRACKING_STATUS_TRANSITIONS,
  trackingStatusBadgeVariant,
  trackingStatusIcon,
  trackingStatusOfApplication,
} from "@/lib/tracking-status";
import { applicationBadgeVariant } from "@/components/application-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

// The slide-over opened from an Applications-table row (#237), modelled on
// `AnalysisQuickView` but scoped to tracking: no score gauge, no document
// generation, no relaunch or requeue — those belong to /analyses. The
// Application's own fields come from the list row the page already has; the
// full StatusEvent timeline from `GET /applications/:id`, which also fills the
// offer's location, platform and `sourceUrl` the list row does not carry yet.

export function ApplicationQuickView({
  application,
  open,
  onOpenChange,
  returnFocusRef,
  position,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  application: ApplicationSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row to focus again on close (see `AnalysisQuickView`): the page
   *  keeps it pointed at the Application currently shown. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** 1-based rank in the filtered, sorted list, or `null` once a status
   *  change from this panel has dropped it out of the active filter. */
  position: number | null;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("applications");
  const trackingStatusLabel = useEnumLabel("trackingStatus");
  const statusLabel = useEnumLabel("applicationStatus");
  const sourceSiteLabel = useEnumLabel("sourceSite");
  const { data: detail } = useApplication(application?.id ?? null);
  const addStatusEvent = useAddStatusEvent(application?.id ?? "");

  const tracking = application ? trackingStatusOfApplication(application.status) : null;
  const offer = detail?.jobOffer;
  const sourceUrl = application?.jobOffer.sourceUrl ?? offer?.sourceUrl ?? null;
  const location = application?.jobOffer.location ?? offer?.location ?? null;
  const sourceSite = application?.jobOffer.sourceSite ?? offer?.sourceSite ?? null;
  const fields = application
    ? [
        {
          label: t("quickView.appliedAt"),
          value: application.appliedAt
            ? new Date(application.appliedAt).toLocaleDateString()
            : null,
        },
        { label: t("quickView.cvUsed"), value: application.cvVersion.label },
        { label: t("quickView.company"), value: application.jobOffer.company },
        { label: t("quickView.location"), value: location },
        { label: t("quickView.platform"), value: sourceSite && sourceSiteLabel(sourceSite) },
      ]
    : [];
  // Newest first, whatever order the API returns them in.
  const events = detail
    ? [...detail.statusEvents].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
    : null;
  const documents = application
    ? [
        { id: application.tailoredCvDocId, label: t("quickView.tailoredCv") },
        { id: application.coverLetterDocId, label: t("quickView.coverLetter") },
      ].filter((doc): doc is { id: string; label: string } => doc.id !== null)
    : [];

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) addStatusEvent.reset();
    onOpenChange(nextOpen);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        className="w-full gap-6 overflow-y-auto sm:max-w-2xl"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          if ((event.target as HTMLElement).closest("input, select, textarea")) return;
          if (event.key === "ArrowLeft" && hasPrevious) {
            event.preventDefault();
            onPrevious();
          }
          if (event.key === "ArrowRight" && hasNext) {
            event.preventDefault();
            onNext();
          }
        }}
      >
        <div className="sticky top-0 z-10 -mx-6 -mt-6 flex items-center justify-between gap-3 border-b border-border bg-background px-6 py-3">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasPrevious}
              onClick={onPrevious}
            >
              <ChevronLeft aria-hidden="true" />
              {t("quickView.previous")}
            </Button>
            <span aria-live="polite" className="hidden px-2 text-sm tabular-nums text-muted sm:inline">
              {position === null
                ? t("quickView.positionUnknown", { total })
                : t("quickView.position", { position, total })}
            </span>
            <Button type="button" variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
              {t("quickView.next")}
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="sm">
              <X aria-hidden="true" />
              {t("quickView.close")}
            </Button>
          </SheetClose>
        </div>

        {application && tracking !== null && (
          <>
            <SheetHeader>
              <SheetTitle>{application.jobOffer.title ?? t("list.jobOfferFallback")}</SheetTitle>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
                <p>
                  {application.jobOffer.company ?? "—"} · {location ?? "—"}
                </p>
                <Badge variant={trackingStatusBadgeVariant(tracking)}>
                  {trackingStatusLabel(tracking)}
                </Badge>
              </div>
            </SheetHeader>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {fields.map((field) => (
                <div key={field.label} className="contents">
                  <dt className="text-muted">{field.label}</dt>
                  <dd className="min-w-0 break-words">{field.value || "—"}</dd>
                </div>
              ))}
            </dl>

            <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
              <Button asChild size="sm">
                <Link href={`/analyses/${application.analysisId}`}>
                  {t("detail.viewAnalysis")}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              {application.scoutId && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/scouts?open=${application.scoutId}`}>{t("detail.viewScout")}</Link>
                </Button>
              )}
              {sourceUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    {t("quickView.viewOffer")}
                  </a>
                </Button>
              )}
              {documents.map((doc) => (
                <Button key={doc.id} asChild variant="outline" size="sm">
                  <a href={`/api/generated-documents/${doc.id}/download?format=pdf`} download>
                    <FileText aria-hidden="true" />
                    {doc.label}
                  </a>
                </Button>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {TRACKING_STATUS_TRANSITIONS.filter(
                  (transition) => transition.trackingStatus !== tracking,
                ).map((transition) => {
                  const Icon = trackingStatusIcon(transition.trackingStatus);
                  return (
                    <Button
                      key={transition.trackingStatus}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={addStatusEvent.isPending}
                      onClick={() =>
                        addStatusEvent.mutate({
                          status: transition.applicationStatus,
                          effectiveDate: new Date().toISOString(),
                        })
                      }
                    >
                      <Icon aria-hidden="true" />
                      {trackingStatusLabel(transition.trackingStatus)}
                    </Button>
                  );
                })}
              </div>
              {addStatusEvent.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {t("detail.statusError")}
                </p>
              )}
            </div>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-muted">{t("detail.timelineHeading")}</h3>
              {events === null ? (
                <p role="status" className="text-sm text-muted">
                  {t("detail.loading")}
                </p>
              ) : events.length === 0 ? (
                <p className="text-sm text-muted">{t("detail.timelineEmpty")}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {events.map((event) => (
                    <li key={event.id} className="flex flex-col gap-1 text-sm">
                      <div className="flex items-center justify-between gap-4">
                        <Badge variant={applicationBadgeVariant(event.status)}>
                          {statusLabel(event.status)}
                        </Badge>
                        <span className="text-xs text-muted">
                          {new Date(event.effectiveDate).toLocaleDateString()}
                        </span>
                      </div>
                      {event.note && <p className="text-foreground">{event.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
