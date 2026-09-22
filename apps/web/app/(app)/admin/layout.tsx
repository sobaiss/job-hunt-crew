import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";

// Gates the whole Admin area (issue #138): a signed-out visit redirects to
// sign-in (proxy.ts's matcher already covers this at the cookie-presence
// level, but a session can expire mid-visit); a signed-in Candidate who
// isn't an Administrator gets a 404 rather than a redirect, so the area's
// existence isn't disclosed to a non-Administrator. Admin access is
// decoupled from Plan (issue #144, docs/adr/0015) and gated on Role rather
// than the retired `isAdmin` boolean (issue #156, docs/adr/0017):
// `session.user.role` is checked here (not in proxy.ts), which deliberately
// never decodes the JWT.
//
// The gate is all this layout does: the Admin area's seven sections are nav
// rows in the App shell's Sidebar (`components/app-sidebar.tsx`'s
// ADMIN_NAV_ITEMS), so there is no second menu inside the area to mount here.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
    return null;
  }
  if (session.user.role !== "ADMINISTRATOR") {
    notFound();
    return null;
  }

  return <>{children}</>;
}
