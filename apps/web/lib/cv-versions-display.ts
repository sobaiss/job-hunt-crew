import type { CvConversionStatus, CvVersion } from "@/hooks/use-cv-versions";

// Presentational helpers shared between the CV-versions table (#80) and the
// CV panel (#81) — both render the same file-size and Conversion-status
// formatting for a `CvVersion`.

/** Human-readable file size, e.g. `12.3 KB` — no existing helper for this. */
export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function conversionBadgeVariant(
  status: CvConversionStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "CONVERTED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "CONVERTING") return "warning";
  return "secondary";
}

/**
 * How many CVVersion rows make up the same CV as `current` (docs/adr/0027)
 * — `current` itself plus every ancestor reached by walking `supersededById`
 * backward through `cvVersions`. Deleting `current` removes the whole
 * chain, so this is what lets the delete confirmation name its size; only
 * ever called with the chain's current (non-superseded) row, so there's
 * nothing to walk forward.
 */
export function cvChainLength(cvVersions: CvVersion[], current: CvVersion): number {
  let count = 1;
  let node = current;
  for (;;) {
    const predecessor = cvVersions.find((cv) => cv.supersededById === node.id);
    if (!predecessor) return count;
    count += 1;
    node = predecessor;
  }
}
