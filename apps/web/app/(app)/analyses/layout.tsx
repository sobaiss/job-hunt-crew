import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

// An Administrator has no Analyses of their own — that data only exists
// per-Candidate — so a direct visit here (the nav row is already hidden, see
// app-sidebar.tsx's ADMIN_HIDDEN_NAV_KEYS) is redirected to the Admin-area
// equivalent, which covers every Candidate's Analyses (issue #161).
export default async function AnalysesLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (session?.user?.role === "ADMINISTRATOR") {
    redirect("/admin/analyses");
    return null;
  }
  return <>{children}</>;
}
