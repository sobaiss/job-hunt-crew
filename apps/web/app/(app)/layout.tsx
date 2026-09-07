import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AppTopbar } from "@/components/app-topbar";

// The App shell around every signed-in page: a persistent left Sidebar (brand,
// "New analysis" action, nav, account menu) plus a context Topbar (page title,
// page actions, and the drawer trigger on narrow viewports). Route protection
// is handled by proxy.ts; public pages live in app/(public) and never mount
// this.
export default function AppLayout({ children }: { children: ReactNode }) {
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
