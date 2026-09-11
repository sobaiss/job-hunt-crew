import { describe, expect, it } from "vitest";

import { compareColumns } from "@/lib/compare-columns";
import type { AnalysisDetail } from "@/hooks/use-analyses";

function analysis(over: Partial<AnalysisDetail> = {}): AnalysisDetail {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv1",
    ingestionJobId: null,
    scoutId: null,
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme" },
    cvVersion: { label: "Grad CV" },
    ingestionJob: null,
    resultJSON: null,
    errorMessage: null,
    ...over,
  };
}

describe("compareColumns", () => {
  it("returns one column per distinct CV version, in first-seen order", () => {
    const cols = compareColumns([
      analysis({ id: "a1", cvVersion: { label: "Grad CV" } }),
      analysis({ id: "a2", cvVersion: { label: "Senior CV" } }),
    ]);

    expect(cols.map((c) => c.cvVersion.label)).toEqual(["Grad CV", "Senior CV"]);
  });

  it("keeps the most recent analysis when a CV version was re-run", () => {
    const cols = compareColumns([
      analysis({
        id: "old",
        cvVersion: { label: "Grad CV" },
        requestedAt: "2026-08-01T00:00:00.000Z",
      }),
      analysis({
        id: "new",
        cvVersion: { label: "Grad CV" },
        requestedAt: "2026-08-05T00:00:00.000Z",
      }),
    ]);

    expect(cols).toHaveLength(1);
    expect(cols[0].id).toBe("new");
  });

  it("passes a single analysis through unchanged", () => {
    const only = analysis({ id: "solo" });
    expect(compareColumns([only])).toEqual([only]);
  });
});
