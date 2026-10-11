import { csvField } from "@/lib/analyses-csv";
import type { ApplicationSummary } from "@/lib/applications-filters";
import { trackingStatusOfApplication } from "@/lib/tracking-status";

// The Applications bulk-actions bar's CSV export (#235), mirroring
// `analyses-csv.ts`: a pure formatter over already-loaded rows, no new
// endpoint. The download itself reuses `downloadCsv` from that module. A
// field the row lacks — null, or not yet sent by the list endpoint (location,
// platform, score, document statuses) — is an empty cell.

const CSV_HEADER = [
  "Position",
  "Company",
  "Location",
  "Platform",
  "Applied",
  "Score",
  "Status",
  "Tailored CV",
  "Cover letter",
];

export type ApplicationsCsvLabelers = {
  sourceSiteLabel: (value: string) => string;
  trackingStatusLabel: (value: string) => string;
  documentStatusLabel: (value: string) => string;
};

/** One `\n`-separated CSV document for the given Applications, in the order
 *  given — the caller is responsible for ordering/selecting rows. */
export function applicationsToCsv(
  applications: ApplicationSummary[],
  labelers: ApplicationsCsvLabelers,
): string {
  const rows = applications.map((application) => {
    const { jobOffer } = application;
    return [
      jobOffer.title ?? "",
      jobOffer.company ?? "",
      jobOffer.location ?? "",
      jobOffer.sourceSite ? labelers.sourceSiteLabel(jobOffer.sourceSite) : "",
      application.appliedAt ?? "",
      application.matchScore != null ? String(application.matchScore) : "",
      labelers.trackingStatusLabel(trackingStatusOfApplication(application.status)),
      application.tailoredCvStatus ? labelers.documentStatusLabel(application.tailoredCvStatus) : "",
      application.coverLetterStatus ? labelers.documentStatusLabel(application.coverLetterStatus) : "",
    ]
      .map(csvField)
      .join(",");
  });
  return [CSV_HEADER.join(","), ...rows].join("\n");
}
