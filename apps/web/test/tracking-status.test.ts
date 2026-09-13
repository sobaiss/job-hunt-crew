import { describe, expect, it } from "vitest";

import {
  TRACKING_STATUSES,
  trackingStatusBadgeVariant,
  trackingStatusOf,
} from "@/lib/tracking-status";
import type { ApplicationStatus } from "@/hooks/use-applications";

describe("trackingStatusOf", () => {
  it("is null for a non-COMPLETED Analysis regardless of applicationStatus", () => {
    expect(
      trackingStatusOf({ status: "RUNNING_CREW", applicationStatus: null }),
    ).toBeNull();
    expect(
      trackingStatusOf({ status: "PENDING", applicationStatus: "APPLIED" }),
    ).toBeNull();
  });

  it("is null for a FAILED Analysis", () => {
    expect(
      trackingStatusOf({ status: "FAILED", applicationStatus: null }),
    ).toBeNull();
  });

  it("is TO_APPLY for a COMPLETED Analysis with no Application yet", () => {
    expect(
      trackingStatusOf({ status: "COMPLETED", applicationStatus: null }),
    ).toBe("TO_APPLY");
  });

  it.each([
    ["DRAFT", "TO_APPLY"],
    ["APPLIED", "IN_PROGRESS"],
    ["INTERVIEWING", "IN_PROGRESS"],
    ["OFFER", "IN_PROGRESS"],
    ["ACCEPTED", "ACCEPTED"],
    ["REJECTED", "REJECTED"],
    ["WITHDRAWN", "WITHDRAWN"],
  ] as const)(
    "folds ApplicationStatus %s into Tracking status %s",
    (applicationStatus: ApplicationStatus, expected) => {
      expect(
        trackingStatusOf({ status: "COMPLETED", applicationStatus }),
      ).toBe(expected);
    },
  );

  it("exposes exactly the 5 buckets", () => {
    expect(TRACKING_STATUSES).toEqual([
      "TO_APPLY",
      "IN_PROGRESS",
      "REJECTED",
      "ACCEPTED",
      "WITHDRAWN",
    ]);
  });
});

describe("trackingStatusBadgeVariant", () => {
  it("maps each bucket to a badge variant", () => {
    expect(trackingStatusBadgeVariant("TO_APPLY")).toBe("secondary");
    expect(trackingStatusBadgeVariant("IN_PROGRESS")).toBe("warning");
    expect(trackingStatusBadgeVariant("ACCEPTED")).toBe("success");
    expect(trackingStatusBadgeVariant("REJECTED")).toBe("destructive");
    expect(trackingStatusBadgeVariant("WITHDRAWN")).toBe("destructive");
  });
});
