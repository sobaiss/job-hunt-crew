import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

// An Administrator has no Scouts of their own — that data only exists
// per-Candidate — so a direct visit here (the nav row is already hidden, see
// app-sidebar.tsx's ADMIN_HIDDEN_NAV_KEYS) is redirected to the Admin-area
// equivalent, which covers every Candidate's Scouts (issue #162).
export default async function ScoutsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (session?.user?.role === "ADMINISTRATOR") {
    redirect("/admin/scouts");
    return null;
  }
  return <>{children}</>;
}
