import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";

// The App shell around every signed-in page. Route protection is handled by
// proxy.ts; public pages live in app/(public) and never mount this. The
// signed-in `/` Dashboard is outside this route group (app/(public)/page.tsx is
// the `/` route) and composes <AppShell> itself.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
