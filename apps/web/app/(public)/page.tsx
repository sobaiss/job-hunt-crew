import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard";
import { LandingPage } from "@/components/landing-page";

// The public front door. A signed-out Visitor sees the marketing page; a
// signed-in Candidate gets the Dashboard (spec #43) inside the App shell — the
// `/` route lives in this group, so it composes the shell itself rather than
// inheriting app/(app)/layout.tsx. An Administrator has no Analyses, Scouts,
// or CV Versions to summarize, so this Dashboard is meaningless for that role
// (the nav row is already hidden, see app-sidebar.tsx's ADMIN_HIDDEN_NAV_KEYS)
// — it's redirected to the Admin dashboard instead.
export default async function LandingRoute() {
  const session = await auth();
  if (session?.user) {
    if (session.user.role === "ADMINISTRATOR") {
      redirect("/admin");
      return null;
    }
    return (
      <AppShell>
        <Dashboard />
      </AppShell>
    );
  }

  return <LandingPage />;
}
