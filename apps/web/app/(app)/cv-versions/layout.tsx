import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

// An Administrator has no CV Versions of their own — that data only exists
// per-Candidate — so a direct visit here (the nav row is already hidden, see
// app-sidebar.tsx's ADMIN_HIDDEN_NAV_KEYS) is redirected to the Admin-area
// equivalent, which covers every Candidate's CV Versions (issue #163).
export default async function CvVersionsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (session?.user?.role === "ADMINISTRATOR") {
    redirect("/admin/cv-versions");
    return null;
  }
  return <>{children}</>;
}
