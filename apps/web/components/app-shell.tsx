import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AppTopbar } from "@/components/app-topbar";

/**
 * The App shell around every signed-in surface: a persistent left Sidebar plus
 * a context Topbar. Mounted by `app/(app)/layout.tsx` for the signed-in route
 * group, and directly by the `/` route for a signed-in Candidate (whose
 * Dashboard lives outside that group — see `app/(public)/page.tsx`).
 *
 * Pinned to the viewport height: only the `<main>` region scrolls with page
 * content, so the Sidebar (and the account menu pinned to its bottom) stays
 * on screen even on a long page (e.g. a large table) instead of being pushed
 * below the fold along with it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppTopbar />
        {/* Each page supplies its own `<main>`; this only owns the scroll. */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
