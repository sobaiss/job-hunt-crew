import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard";
import { LandingPage } from "@/components/landing-page";

// The public front door. A signed-out Visitor sees the marketing page; a
// signed-in Candidate gets the Dashboard (spec #43) inside the App shell — the
// `/` route lives in this group, so it composes the shell itself rather than
// inheriting app/(app)/layout.tsx.
export default async function LandingRoute() {
  const session = await auth();
  if (session?.user) {
    return (
      <AppShell>
        <Dashboard />
      </AppShell>
    );
  }

  return <LandingPage />;
}
