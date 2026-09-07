import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AppTopbar } from "@/components/app-topbar";

/**
 * The App shell around every signed-in surface: a persistent left Sidebar plus
 * a context Topbar. Mounted by `app/(app)/layout.tsx` for the signed-in route
 * group, and directly by the `/` route for a signed-in Candidate (whose
 * Dashboard lives outside that group — see `app/(public)/page.tsx`).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar />
        {children}
      </div>
    </div>
  );
}
