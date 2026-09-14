import type { CvConversionStatus } from "@/hooks/use-cv-versions";

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
