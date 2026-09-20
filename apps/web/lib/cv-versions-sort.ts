import type { CvVersion } from "@/hooks/use-cv-versions";

// Pure, framework-free sort helper behind the CV-versions table (#80),
// mirroring the sort half of `apps/web/lib/analyses-filters.ts`. Sorting is
// applied client-side to the list `useCvVersions()` already returns — no new
// query parameter, no server work.

export type CvVersionsSortColumn =
  | "label"
  | "id"
  | "file"
  | "size"
  | "uploaded"
  | "status"
  | "default";

export type CvVersionsSortDirection = "asc" | "desc";

export type CvVersionsSortState = {
  column: CvVersionsSortColumn;
  direction: CvVersionsSortDirection;
};

/** Newest upload first, per issue #80. */
export const DEFAULT_CV_VERSIONS_SORT: CvVersionsSortState = {
  column: "uploaded",
  direction: "desc",
};

function sortValue(
  cv: CvVersion,
  column: CvVersionsSortColumn,
): string | number | null {
  switch (column) {
    case "label":
      return cv.label;
    case "id":
      return cv.id;
    case "file":
      return cv.fileName;
    case "size":
      return cv.fileSizeBytes;
    case "uploaded":
      return cv.createdAt;
    case "status":
      return cv.conversionStatus;
    case "default":
      return cv.isDefault ? 1 : 0;
  }
}

/**
 * Sorts by one column. A row with no value for that column always sorts last
 * regardless of direction, matching `sortAnalyses` — no `CvVersion` field is
 * actually nullable today, but the rule is kept for parity and in case a
 * future column (e.g. a nullable date) needs it.
 */
export function sortCvVersions(
  cvVersions: CvVersion[],
  sort: CvVersionsSortState,
): CvVersion[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...cvVersions].sort((a, b) => {
    const va = sortValue(a, sort.column);
    const vb = sortValue(b, sort.column);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * factor;
    }
    return String(va).localeCompare(String(vb)) * factor;
  });
}
