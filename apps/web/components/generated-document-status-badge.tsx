import type { GeneratedDocumentStatus } from "@/hooks/use-generated-documents";
import { Badge } from "@/components/ui/badge";

// Shared by the Analyses and Applications tables' "CV generated" / "Cover
// letter generated" columns, so one document status reads the same on both.

function generatedDocumentStatusBadgeVariant(
  status: GeneratedDocumentStatus,
): "secondary" | "warning" | "success" | "destructive" {
  if (status === "READY") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "GENERATING") return "warning";
  return "secondary";
}

/** Renders a status Badge for a Tailored CV/Cover letter GeneratedDocument, or
 *  a plain "—" when generation was never triggered (or the row does not carry
 *  the status at all). */
export function GeneratedDocumentStatusBadge({
  status,
  label,
}: {
  status: GeneratedDocumentStatus | null | undefined;
  label: (value: string) => string;
}) {
  if (status == null) return <span className="text-muted">—</span>;
  return (
    <Badge variant={generatedDocumentStatusBadgeVariant(status)}>
      {label(status)}
    </Badge>
  );
}
