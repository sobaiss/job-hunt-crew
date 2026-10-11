import type { ApplicationStatus } from "@/hooks/use-applications";

export function applicationBadgeVariant(
  status: ApplicationStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACCEPTED" || status === "OFFER") return "success";
  if (status === "REJECTED" || status === "WITHDRAWN") return "destructive";
  if (status === "DRAFT") return "secondary";
  return "warning";
}
