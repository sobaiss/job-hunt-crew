import type { AnalysisSummary } from "@/hooks/use-analyses";
import { trackingStatusOf } from "@/lib/tracking-status";

// The bulk-actions bar's CSV export (issue #67): a pure, framework-free
// formatter over already-loaded `AnalysisSummary` rows — no new endpoint, per
// the issue. Mirrors the table's visible columns (Poste, Entreprise,
// Plateforme, Date de publication, CV, Score, Statut) plus the offer's
// `sourceUrl`, which the table only exposes as the icon-only "Lien" column.

const CSV_HEADER = [
  "Position",
  "Company",
  "Platform",
  "Posted",
  "CV",
  "Score",
  "Status",
  "Link",
];

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type AnalysesCsvLabelers = {
  sourceSiteLabel: (value: string) => string;
  pipelineStatusLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
};

/** One CSV document (CRLF-free, `\n`-separated) for the given Analyses, in
 *  the order given — the caller is responsible for ordering/selecting rows. */
export function analysesToCsv(
  analyses: AnalysisSummary[],
  labelers: AnalysesCsvLabelers,
): string {
  const rows = analyses.map((analysis) => {
    const tracking = trackingStatusOf(analysis);
    const status =
      tracking !== null
        ? labelers.trackingStatusLabel(tracking)
        : labelers.pipelineStatusLabel(analysis.status);
    return [
      analysis.jobOffer.title ?? "",
      analysis.jobOffer.company ?? "",
      labelers.sourceSiteLabel(analysis.jobOffer.sourceSite),
      analysis.jobOffer.postedAt ?? "",
      analysis.cvVersion.label,
      analysis.matchScore !== null ? String(analysis.matchScore) : "",
      status,
      analysis.jobOffer.sourceUrl,
    ]
      .map(csvField)
      .join(",");
  });
  return [CSV_HEADER.join(","), ...rows].join("\n");
}

/** Triggers a browser download of `csv` as `filename` — no network request,
 *  per the issue. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
