import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";

// An Administrator has no Applications of their own — that data only exists
// per-Candidate — and unlike Analyses/Scouts/CV versions/Quotas there is no
// Admin-area equivalent to send them to instead, so the nav row is hidden
// (see app-sidebar.tsx's ADMIN_HIDDEN_NAV_KEYS) and a direct visit 404s,
// mirroring how app/(app)/admin/layout.tsx hides that area from non-Admins.
export default async function ApplicationsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (session?.user?.role === "ADMINISTRATOR") {
    notFound();
    return null;
  }
  return <>{children}</>;
}
