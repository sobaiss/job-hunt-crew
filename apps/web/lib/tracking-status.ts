import { CircleCheck, CircleX, Send, Undo2, type LucideIcon } from "lucide-react";

import type { ApplicationStatus } from "@/hooks/use-applications";
import type { AnalysisSummary } from "@/hooks/use-analyses";

// The Analyses table's "Statut" column and filter (issue #64): folds an
// Analysis's pipeline `status` plus its linked Application's `status` (or the
// absence of one, since it's created lazily) into 5 candidate-facing buckets.
// Only meaningful once an Analysis is `COMPLETED` — a still-running or
// `FAILED` Analysis has no Tracking status and shows its pipeline state
// instead (see `analysisBadgeVariant` in `components/analysis-row.tsx`).

export type TrackingStatus =
  | "TO_APPLY"
  | "IN_PROGRESS"
  | "REJECTED"
  | "ACCEPTED"
  | "WITHDRAWN";

/** In the Statut filter's display order. */
export const TRACKING_STATUSES: readonly TrackingStatus[] = [
  "TO_APPLY",
  "IN_PROGRESS",
  "REJECTED",
  "ACCEPTED",
  "WITHDRAWN",
];

/**
 * The raw pipeline `AnalysisStatus`es the Statut filter gives a bucket of
 * their own, in the filter's display order after the Tracking ones. Each is
 * matched against `Analysis.status` directly rather than folded through
 * `trackingStatusOf`, which is `null` for all of them. `FAILED` came first
 * (issue #172) because a failed Analysis already shows its raw pipeline
 * status as the Statut column's fallback but had no matching bucket;
 * `PENDING` ("En attente") follows for the same reason, and because it is the
 * status a stuck Analysis sits in (docs/adr/0032) — the one a candidate or an
 * Administrator most needs to single out to repair. The remaining non-terminal
 * statuses (`QUEUED`/`RUNNING_CREW`/`AWAITING_RESULT`/`PERSISTING`) stay
 * unfilterable individually — only an empty selection shows them.
 */
export const PIPELINE_ANALYSES_STATUS_FILTERS = ["PENDING", "FAILED"] as const;

export type PipelineAnalysesStatusFilter =
  (typeof PIPELINE_ANALYSES_STATUS_FILTERS)[number];

/** The Analyses tables' (candidate and admin) full Statut filter vocabulary:
 *  the 5 Tracking status buckets plus the pipeline ones above. */
export type AnalysesStatusFilter = TrackingStatus | PipelineAnalysesStatusFilter;

export const ANALYSES_STATUS_FILTERS: readonly AnalysesStatusFilter[] = [
  ...TRACKING_STATUSES,
  ...PIPELINE_ANALYSES_STATUS_FILTERS,
];

/** Whether a bucket names a raw pipeline status — so both tables label it with
 *  `analysisStatus` rather than `trackingStatus`, and both filters match it
 *  against `Analysis.status` instead of a Tracking bucket. */
export function isPipelineStatusFilter(
  status: AnalysesStatusFilter,
): status is PipelineAnalysesStatusFilter {
  return (PIPELINE_ANALYSES_STATUS_FILTERS as readonly string[]).includes(status);
}

const APPLICATION_STATUS_TO_TRACKING: Record<ApplicationStatus, TrackingStatus> = {
  DRAFT: "TO_APPLY",
  APPLIED: "IN_PROGRESS",
  INTERVIEWING: "IN_PROGRESS",
  OFFER: "IN_PROGRESS",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
};

/**
 * The Tracking status bucket for one Analysis, or `null` when the Analysis
 * isn't `COMPLETED` yet (still running, or `FAILED`) — that case renders a
 * pipeline-state badge instead and matches no Tracking status filter bucket.
 */
export function trackingStatusOf(
  analysis: Pick<AnalysisSummary, "status" | "applicationStatus">,
): TrackingStatus | null {
  if (analysis.status !== "COMPLETED") return null;
  if (!analysis.applicationStatus) return "TO_APPLY";
  return APPLICATION_STATUS_TO_TRACKING[analysis.applicationStatus];
}

/** Mirrors `applicationBadgeVariant` (components/application-row.tsx) over
 *  the 5-bucket Tracking status instead of the raw 7-value enum. */
export function trackingStatusBadgeVariant(
  status: TrackingStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACCEPTED") return "success";
  if (status === "REJECTED" || status === "WITHDRAWN") return "destructive";
  if (status === "TO_APPLY") return "secondary";
  return "warning";
}

/** The icon a "move to this status" button carries, alongside
 *  `trackingStatusBadgeVariant`'s colour — shared so the same transition looks
 *  the same in the Quick view and in the Analyses bulk bar (DESIGN.md,
 *  "Buttons"). `TO_APPLY` is here for completeness; no button offers it. */
const TRACKING_STATUS_ICONS: Record<TrackingStatus, LucideIcon> = {
  TO_APPLY: Send,
  IN_PROGRESS: Send,
  REJECTED: CircleX,
  ACCEPTED: CircleCheck,
  WITHDRAWN: Undo2,
};

export function trackingStatusIcon(status: TrackingStatus): LucideIcon {
  return TRACKING_STATUS_ICONS[status];
}

/** The Tracking-status transitions the Quick view's action buttons offer
 * (issue #66) — every bucket except `TO_APPLY`, since reaching it would mean
 * undoing a StatusEvent, which stays out of scope (no undo endpoint; see
 * `services/api`'s CONTEXT.md). */
export const TRACKING_STATUS_TRANSITIONS: readonly {
  trackingStatus: Exclude<TrackingStatus, "TO_APPLY">;
  applicationStatus: ApplicationStatus;
}[] = [
  { trackingStatus: "IN_PROGRESS", applicationStatus: "APPLIED" },
  { trackingStatus: "REJECTED", applicationStatus: "REJECTED" },
  { trackingStatus: "ACCEPTED", applicationStatus: "ACCEPTED" },
  { trackingStatus: "WITHDRAWN", applicationStatus: "WITHDRAWN" },
];
