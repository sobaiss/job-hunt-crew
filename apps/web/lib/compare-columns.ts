// Pure, framework-free: reduce the analyses for one JobOffer to one column per
// distinct CVVersion for the Side-by-side comparison table (#46).
//
// A CV version can be analysed against the same offer more than once (a re-run),
// so the list `/api/analyses?jobOfferId=…` returns can carry several rows for
// one CVVersion. The comparison shows one column per CV version, keyed by
// `cvVersionId` (not `cvVersion.label`, which is not unique — see #182),
// keeping the most recent Analysis by `requestedAt`, in first-seen order.

import type { AnalysisDetail } from "@/hooks/use-analyses";

export function compareColumns(analyses: AnalysisDetail[]): AnalysisDetail[] {
  const byId = new Map<string, AnalysisDetail>();
  for (const a of analyses) {
    const seen = byId.get(a.cvVersionId);
    if (!seen || a.requestedAt > seen.requestedAt) {
      byId.set(a.cvVersionId, a);
    }
  }
  return [...byId.values()];
}
