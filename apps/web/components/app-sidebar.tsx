"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import {
  Bot,
  ChevronsUpDown,
  ClipboardList,
  FileText,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Plus,
  Settings,
  ShieldCheck,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitch } from "@/components/locale-switch";

// The primary areas a Candidate reaches from anywhere. "New analysis" is a
// primary-action button, not a nav row, so it is not in this list. Settings is
// linked here but delivered in a later slice; until then the link may 404.
export const NAV_ITEMS = [
  { href: "/", key: "dashboard", Icon: LayoutDashboard },
  { href: "/analyses", key: "analyses", Icon: ListChecks },
  { href: "/scouts", key: "agents", Icon: Bot },
  { href: "/applications", key: "applications", Icon: ClipboardList },
  { href: "/cv-versions", key: "cvVersions", Icon: FileText },
  { href: "/quotas", key: "quotas", Icon: Gauge },
  { href: "/settings", key: "settings", Icon: Settings },
] as const;

// The single entry into the Admin area, rendered only for an Administrator
// (issue #164). Kept out of NAV_ITEMS so the Topbar title lookup (which walks
// NAV_ITEMS) never names an Admin route for a non-Administrator.
const ADMIN_NAV_ITEM = { href: "/admin", key: "admin", Icon: ShieldCheck } as const;

// An Administrator has no CV, Scout, Analysis, or Application of their own —
// that data only exists per-Candidate — so these rows (and the Dashboard,
// which summarizes it) are meaningless for that role and hidden from its
// Sidebar. Dashboard/Analyses/Agents/CV versions/Quotas each have an
// Admin-area equivalent reached via ADMIN_NAV_ITEM instead; Applications has
// none, so that route is fully gone for an Administrator (404 on direct
// visit, see app/(app)/applications/layout.tsx) rather than redirected.
const ADMIN_HIDDEN_NAV_KEYS = new Set<(typeof NAV_ITEMS)[number]["key"]>([
  "dashboard",
  "analyses",
  "agents",
  "cvVersions",
  "quotas",
  "applications",
]);

/**
 * A nav item is active on an exact path match or when the current route is
 * nested under it. `"/"` is special-cased to an exact match only — otherwise
 * the Dashboard row would own every route.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

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

/** The brand wordmark + mark, linking home. */
function SidebarBrand({ onNavigate }: { onNavigate?: () => void }) {
  const tApp = useTranslations("app");
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className="flex items-center gap-2 px-2 py-1"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 28 28"
        className="size-6 flex-none text-accent"
      >
        <rect
          x="1.5"
          y="1.5"
          width="25"
          height="25"
          rx="7"
          fill="currentColor"
          fillOpacity="0.16"
        />
        <circle
          cx="14"
          cy="14"
          r="7"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
        />
        <circle cx="14" cy="14" r="2.6" fill="currentColor" />
        <path
          d="M14 3.2v3.2M14 21.6v3.2M24.8 14h-3.2M6.4 14H3.2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-serif text-base font-semibold tracking-tight">
        {tApp("name")}
      </span>
    </Link>
  );
}

/** The nav rows, with the current route flagged `aria-current`. */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { data: session } = useSession();
  const items =
    session?.user?.role === "ADMINISTRATOR"
      ? [
          ...NAV_ITEMS.filter((item) => !ADMIN_HIDDEN_NAV_KEYS.has(item.key)),
          ADMIN_NAV_ITEM,
        ]
      : NAV_ITEMS;
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map(({ href, key, Icon }) => {
        const active = isNavActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border"
                : "text-muted hover:bg-background/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 flex-none" aria-hidden="true" />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The account menu pinned at the bottom of the Sidebar: the signed-in
 * Candidate's identity, the theme control, the language control, and sign out.
 */
function SidebarAccountMenu() {
  const tMenu = useTranslations("userMenu");
  const { data: session } = useSession();
  const user = session?.user;
  const name = user?.name ?? user?.email ?? "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={tMenu("label")}
          className="flex w-full items-center gap-3 rounded-md border-t border-border px-2 pt-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-8 flex-none items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
            {initials(user?.name, user?.email)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{name}</span>
            {user?.email && (
              <span className="block truncate text-xs text-muted">
                {user.email}
              </span>
            )}
          </span>
          <ChevronsUpDown className="size-4 flex-none text-muted" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-56">
        {name && (
          <>
            <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <div className="flex items-center gap-1 px-1 py-0.5">
          <span className="flex-1 text-sm text-muted">{tMenu("theme")}</span>
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-1 px-1 py-0.5">
          <span className="flex-1 text-sm text-muted">{tMenu("language")}</span>
          <LocaleSwitch />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: "/" })}>
          {tMenu("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Sidebar body: brand, the "New analysis" primary action, the nav, and the
 * account menu. Shared by the persistent {@link AppSidebar} and the mobile
 * drawer rendered from `AppTopbar`. `onNavigate` lets the drawer close itself
 * when a link inside it is followed.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const { data: session } = useSession();
  const isAdministrator = session?.user?.role === "ADMINISTRATOR";
  return (
    <div className="flex h-full w-full flex-col gap-5">
      <SidebarBrand onNavigate={onNavigate} />
      {!isAdministrator && (
        <Button asChild className="w-full">
          <Link href="/analyses/new" onClick={onNavigate}>
            <Plus className="size-4" aria-hidden="true" />
            {t("newAnalysis")}
          </Link>
        </Button>
      )}
      <SidebarNav onNavigate={onNavigate} />
      <div className="mt-auto">
        <SidebarAccountMenu />
      </div>
    </div>
  );
}

/**
 * The persistent left Sidebar framing every signed-in page. Hidden below the
 * `md` breakpoint, where the same content is reached through the drawer in
 * `AppTopbar`. Mounted by `app/(app)/layout.tsx`.
 */
export function AppSidebar() {
  return (
    <aside className="hidden w-64 flex-none border-r border-border bg-panel p-4 md:flex md:flex-col">
      <SidebarContent />
    </aside>
  );
}
