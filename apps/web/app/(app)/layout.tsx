import type { ReactNode } from "react";

import { AppHeader } from "@/components/app-header";

// The App shell around every signed-in page: a persistent header (brand,
// primary navigation, user menu) with the page below it. Route protection is
// handled by proxy.ts; public pages live in app/(public) and never mount this.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <AppHeader />
      {children}
    </div>
  );
}
