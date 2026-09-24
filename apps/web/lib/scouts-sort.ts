import type { Scout, ScoutRunState } from "@/hooks/use-scouts";

// Pure, framework-free sort helper behind the Scouts table (#89), mirroring
// `cv-versions-sort.ts`. Sorting is applied client-side to the list
// `useScouts()` already returns — no new query parameter, no server work.

export type ScoutsSortColumn =
  | "label"
  | "id"
  | "status"
  | "runState"
  | "baseCv"
  | "sites"
  | "lastRun"
  | "relevantFinds";

export type ScoutsSortDirection = "asc" | "desc";

export type ScoutsSortState = {
  column: ScoutsSortColumn;
  direction: ScoutsSortDirection;
};

/**
 * The Execution column's severity rank, worst first (#226). Deliberately not
 * the precedence the API applies when several states hold at once (there,
 * IN_FLIGHT wins): sorting asks "what needs attention", so trouble rises
 * above live work. Coded explicitly rather than left to the labels, whose
 * alphabetical order would break the day a badge is reworded.
 */
export const RUN_STATE_SEVERITY_RANK: Record<ScoutRunState, number> = {
  BLOCKED: 0,
  FAILED: 1,
  DEGRADED: 2,
  IN_FLIGHT: 3,
  OK: 4,
  NEVER_RUN: 5,
};

/** Most recently run first, per issue #89. */
export const DEFAULT_SCOUTS_SORT: ScoutsSortState = {
  column: "lastRun",
  direction: "desc",
};

function sortValue(
  scout: Scout,
  column: ScoutsSortColumn,
  cvLabelById: Map<string, string>,
): string | number | null {
  switch (column) {
    case "label":
      return scout.label;
    case "id":
      return scout.id;
    case "status":
      return scout.status;
    case "runState":
      return RUN_STATE_SEVERITY_RANK[scout.runState];
    case "baseCv":
      return cvLabelById.get(scout.cvVersionId) ?? scout.cvVersionId;
    case "sites":
      return scout.targetSiteKeys.length;
    case "lastRun":
      return scout.lastRunAt;
    case "relevantFinds":
      return scout.relevantFindsCount;
  }
}

/**
 * Sorts by one column. A row with no value for that column (only possible
 * for `lastRun`, i.e. a Scout that has never run) always sorts last
 * regardless of direction, matching `sortCvVersions`.
 *
 * `baseCv` sorts by the CVVersion's resolved label, not the raw
 * `cvVersionId` — callers pass a `cvVersionId -> label` lookup built from
 * the full CV versions list; it defaults to empty, which falls back to
 * sorting by id.
 */
export function sortScouts(
  scouts: Scout[],
  sort: ScoutsSortState,
  cvLabelById: Map<string, string> = new Map(),
): Scout[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...scouts].sort((a, b) => {
    const va = sortValue(a, sort.column, cvLabelById);
    const vb = sortValue(b, sort.column, cvLabelById);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * factor;
    }
    return String(va).localeCompare(String(vb)) * factor;
  });
}
