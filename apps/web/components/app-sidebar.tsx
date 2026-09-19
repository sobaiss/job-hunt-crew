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
  PanelLeftClose,
  PanelLeftOpen,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitch } from "@/components/locale-switch";

// Persisted across reloads the same way ThemeToggle's choice is (a browser
// storage key): only the desktop AppSidebar can be collapsed, so this key is
// read/written from there alone. Read via `useSyncExternalStore` rather than
// an effect + setState, since `localStorage` is external mutable state React
// doesn't own — that also gives a safe `false` snapshot during SSR.
const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";
const sidebarCollapsedListeners = new Set<() => void>();

function subscribeSidebarCollapsed(onChange: () => void) {
  sidebarCollapsedListeners.add(onChange);
  return () => sidebarCollapsedListeners.delete(onChange);
}

function getSidebarCollapsedSnapshot() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function getSidebarCollapsedServerSnapshot() {
  return false;
}

function useSidebarCollapsed() {
  const collapsed = React.useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getSidebarCollapsedServerSnapshot,
  );

  const toggle = React.useCallback(() => {
    localStorage.setItem(
      SIDEBAR_COLLAPSED_KEY,
      String(!getSidebarCollapsedSnapshot()),
    );
    sidebarCollapsedListeners.forEach((listener) => listener());
  }, []);

  return [collapsed, toggle] as const;
}

/** Wraps `children` in a Tooltip showing `label`, but only when `active` — used to explain an icon-only control once its text label has been hidden. */
function MaybeTooltip({
  active,
  label,
  children,
}: {
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

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

/** The brand wordmark + mark, linking home. Icon-only when `collapsed`. */
function SidebarBrand({
  onNavigate,
  collapsed,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const tApp = useTranslations("app");
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 px-2 py-1",
        collapsed && "justify-center",
      )}
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
      <span
        className={cn(
          "font-serif text-base font-semibold tracking-tight",
          collapsed && "sr-only",
        )}
      >
        {tApp("name")}
      </span>
    </Link>
  );
}

/**
 * The nav rows, with the current route flagged `aria-current`. When
 * `collapsed`, each row shows only its icon (the label stays in the DOM as
 * `sr-only` so the link's accessible name is unchanged) and gains a Tooltip
 * so the label is still reachable on hover or focus.
 */
function SidebarNav({
  onNavigate,
  collapsed,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
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
        const label = t(key);
        return (
          <MaybeTooltip key={href} active={!!collapsed} label={label}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                collapsed && "justify-center",
                active
                  ? "bg-background font-medium text-foreground shadow-xs ring-1 ring-border"
                  : "text-muted hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 flex-none" aria-hidden="true" />
              <span className={cn(collapsed && "sr-only")}>{label}</span>
            </Link>
          </MaybeTooltip>
        );
      })}
    </nav>
  );
}

/**
 * The account menu pinned at the bottom of the Sidebar: the signed-in
 * Candidate's identity, the theme control, the language control, and sign out.
 * When `collapsed`, only the avatar shows (the trigger's `aria-label` already
 * names it, so no `sr-only` text is needed) and a Tooltip surfaces the name.
 */
function SidebarAccountMenu({ collapsed }: { collapsed?: boolean }) {
  const tMenu = useTranslations("userMenu");
  const { data: session } = useSession();
  const user = session?.user;
  const name = user?.name ?? user?.email ?? "";

  return (
    <DropdownMenu>
      <MaybeTooltip active={!!collapsed && !!name} label={name}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={tMenu("label")}
            className={cn(
              "flex w-full items-center gap-3 rounded-md border-t border-border px-2 pt-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              collapsed && "justify-center",
            )}
          >
            <span className="flex size-8 flex-none items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
              {initials(user?.name, user?.email)}
            </span>
            <span className={cn("min-w-0 flex-1", collapsed && "hidden")}>
              <span className="block truncate text-sm font-medium">
                {name}
              </span>
              {user?.email && (
                <span className="block truncate text-xs text-muted">
                  {user.email}
                </span>
              )}
            </span>
            <ChevronsUpDown
              className={cn(
                "size-4 flex-none text-muted",
                collapsed && "hidden",
              )}
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
      </MaybeTooltip>
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
 * The Sidebar body: brand (with the collapse toggle when `onToggleCollapsed`
 * is given), the "New analysis" primary action, the nav, and the account
 * menu. Shared by the persistent {@link AppSidebar} and the mobile drawer
 * rendered from `AppTopbar` — the drawer never collapses, so it renders this
 * with `collapsed`/`onToggleCollapsed` left unset. `onNavigate` lets the
 * drawer close itself when a link inside it is followed.
 */
export function SidebarContent({
  onNavigate,
  collapsed,
  onToggleCollapsed,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const t = useTranslations("nav");
  const { data: session } = useSession();
  const isAdministrator = session?.user?.role === "ADMINISTRATOR";
  return (
    <div className="flex h-full w-full flex-col gap-5">
      <div className={cn("flex items-center gap-2", collapsed && "flex-col")}>
        <SidebarBrand onNavigate={onNavigate} collapsed={collapsed} />
        {onToggleCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleCollapsed}
                aria-label={
                  collapsed ? t("expandSidebar") : t("collapseSidebar")
                }
                className={cn(!collapsed && "ml-auto flex-none")}
              >
                {collapsed ? (
                  <PanelLeftOpen className="size-4" aria-hidden="true" />
                ) : (
                  <PanelLeftClose className="size-4" aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? t("expandSidebar") : t("collapseSidebar")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {!isAdministrator && (
        <MaybeTooltip active={!!collapsed} label={t("newAnalysis")}>
          <Button asChild className="w-full">
            <Link href="/analyses/new" onClick={onNavigate}>
              <Plus className="size-4" aria-hidden="true" />
              <span className={cn(collapsed && "sr-only")}>
                {t("newAnalysis")}
              </span>
            </Link>
          </Button>
        </MaybeTooltip>
      )}
      <SidebarNav onNavigate={onNavigate} collapsed={collapsed} />
      <div className="mt-auto">
        <SidebarAccountMenu collapsed={collapsed} />
      </div>
    </div>
  );
}

/**
 * The persistent left Sidebar framing every signed-in page. Hidden below the
 * `md` breakpoint, where the same content is reached through the drawer in
 * `AppTopbar`. Mounted by `app/(app)/layout.tsx`. Can be collapsed to an
 * icon-only rail; the choice is remembered in `localStorage` across reloads.
 */
export function AppSidebar() {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  return (
    <aside
      className={cn(
        "hidden flex-none border-r border-border bg-panel md:flex md:flex-col",
        collapsed ? "w-18 p-3" : "w-64 p-4",
      )}
    >
      <SidebarContent collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
    </aside>
  );
}
