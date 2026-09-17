import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";

// Gates the whole Admin area (issue #138): a signed-out visit redirects to
// sign-in (proxy.ts's matcher already covers this at the cookie-presence
// level, but a session can expire mid-visit); a signed-in Candidate whose
// Plan isn't ADMINISTRATEUR gets a 404 rather than a redirect, so the area's
// existence isn't disclosed to a non-Administrator. `plan === "ADMINISTRATEUR"`
// is checked here (not in proxy.ts), which deliberately never decodes the
// JWT.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
    return null;
  }
  if (session.user.plan !== "ADMINISTRATEUR") {
    notFound();
    return null;
  }

  return <>{children}</>;
}
