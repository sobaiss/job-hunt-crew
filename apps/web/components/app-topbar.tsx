"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  SidebarContent,
  TopbarAccountMenu,
  isNavActive,
  useNavGroups,
} from "@/components/app-sidebar";
import { QuotaAlertsFeed } from "@/components/quota-alerts-feed";

/**
 * The page title shown in the Topbar. Resolved from the current route against
 * the signed-in role's own nav rows ({@link useNavGroups}, longest match wins,
 * so a nested route like `/analyses/new` shows its section title); routes
 * outside the nav fall back to the app name. Since the rows come from there,
 * an Administrator gets the current Admin section named here — the Admin area
 * navigates entirely from the Sidebar and has no tab strip of its own.
 */
function usePageTitle(): string {
  const tApp = useTranslations("app");
  const pathname = usePathname();
  const match = useNavGroups()
    .flatMap((group) => group.items)
    .filter(({ href }) => isNavActive(pathname, href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match ? match.label : tApp("name");
}

/**
 * The context Topbar above every signed-in page: the current page's title, a
 * slot for that page's actions, and — below the `md` breakpoint — the button
 * that opens the Sidebar as a drawer plus an avatar-only account menu, since
 * the persistent Sidebar's own account entry is hidden at that width.
 * Mounted by `app/(app)/layout.tsx`.
 */
export function AppTopbar({ children }: { children?: React.ReactNode }) {
  const t = useTranslations("nav");
  const tApp = useTranslations("app");
  const title = usePageTitle();
  const [navOpen, setNavOpen] = React.useState(false);

  return (
    <header className="flex h-15 flex-none items-center gap-3 border-b border-border px-4 md:px-8">
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={t("openMenu")}
          >
            <Menu className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72">
          <SheetHeader className="sr-only">
            <SheetTitle>{tApp("name")}</SheetTitle>
          </SheetHeader>
          <SidebarContent onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <h1 className="font-serif text-xl font-semibold tracking-tight">
        {title}
      </h1>

      <div className="ml-auto flex items-center gap-2">
        <QuotaAlertsFeed />
        {children}
        <div className="md:hidden">
          <TopbarAccountMenu />
        </div>
      </div>
    </header>
  );
}
