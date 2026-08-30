"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitch } from "@/components/locale-switch";

// The primary areas a Candidate reaches in one click. Order is
// Dashboard (the analyses list) -> CV versions -> start a new ingestion.
const NAV_LINKS = [
  { href: "/analyses", key: "dashboard" },
  { href: "/cv-versions", key: "cvVersions" },
  { href: "/ingestion-jobs/new", key: "newIngestion" },
] as const;

/** Two-letter monogram for the avatar fallback, from the name then the email. */
function initials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.trim() || "";
  if (!source) return "?";
  const words = source.split(/\s+/);
  if (words.length > 1) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function NavLinks({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");
  return (
    <>
      {NAV_LINKS.map(({ href, key }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "text-sm transition-colors hover:text-foreground",
              active ? "text-foreground" : "text-muted",
            )}
          >
            {t(key)}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The App shell header: brand, primary navigation, and a user menu holding the
 * theme control, the language control, and sign out. Mounted by
 * `app/(app)/layout.tsx`, so it frames every signed-in page; the public Landing
 * and sign-in pages live in `app/(public)` and never render it.
 *
 * On narrow viewports the inline nav is hidden (CSS) and the same links move
 * into a Sheet opened from the menu button.
 */
export function AppHeader() {
  const t = useTranslations("nav");
  const tMenu = useTranslations("userMenu");
  const tApp = useTranslations("app");
  const pathname = usePathname();
  const { data: session } = useSession();
  const [navOpen, setNavOpen] = React.useState(false);

  const user = session?.user;

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-4">
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
          <SheetContent side="left">
            <SheetHeader>
              <SheetTitle className="font-serif">{tApp("name")}</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-4">
              <NavLinks
                pathname={pathname}
                onNavigate={() => setNavOpen(false)}
              />
            </nav>
          </SheetContent>
        </Sheet>

        <Link
          href="/analyses"
          className="font-serif text-lg font-semibold tracking-tight"
        >
          {tApp("name")}
        </Link>

        <nav className="hidden items-center gap-5 md:flex">
          <NavLinks pathname={pathname} />
        </nav>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={tMenu("label")}
              >
                <Avatar>
                  <AvatarFallback>
                    {initials(user?.name, user?.email)}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {(user?.name || user?.email) && (
                <>
                  <DropdownMenuLabel className="truncate">
                    {user?.name ?? user?.email}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              <div className="flex items-center gap-1 px-1 py-0.5">
                <span className="flex-1 text-sm text-muted">
                  {tMenu("theme")}
                </span>
                <ThemeToggle />
              </div>
              <div className="flex items-center gap-1 px-1 py-0.5">
                <span className="flex-1 text-sm text-muted">
                  {tMenu("language")}
                </span>
                <LocaleSwitch />
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void signOut()}>
                {tMenu("signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
