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
  Cpu,
  FileText,
  Gauge,
  LayoutDashboard,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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

// The seven screens of the Admin area, in nav order — labels live under
// `admin.nav`, not `nav`. An Administrator reaches each one straight from the
// Sidebar (issue #164 originally stacked a tab strip inside the area on top of
// the Sidebar; the sections moved up here so the area has one menu, not two),
// so the Admin screens never render a nav of their own. Kept out of NAV_ITEMS
// so the Topbar title lookup never names an Admin route for a
// non-Administrator — see `useNavGroups`, which only hands these out to one.
export const ADMIN_NAV_ITEMS = [
  { href: "/admin", key: "dashboard", Icon: LayoutDashboard },
  { href: "/admin/users", key: "users", Icon: Users },
  { href: "/admin/quotas", key: "planDefaults", Icon: Gauge },
  { href: "/admin/analyses", key: "analyses", Icon: ListChecks },
  { href: "/admin/scouts", key: "scouts", Icon: Bot },
  { href: "/admin/cv-versions", key: "cvVersions", Icon: FileText },
  { href: "/admin/llm-providers", key: "llmProviders", Icon: Cpu },
] as const;

// An Administrator has no CV, Scout, Analysis, or Application of their own —
// that data only exists per-Candidate — so these rows (and the Dashboard,
// which summarizes it) are meaningless for that role and hidden from its
// Sidebar. Dashboard/Analyses/Agents/CV versions/Quotas each have an
// Admin-area equivalent in ADMIN_NAV_ITEMS instead; Applications has none, so
// that route is fully gone for an Administrator (404 on direct visit, see
// app/(app)/applications/layout.tsx) rather than redirected.
const ADMIN_HIDDEN_NAV_KEYS = new Set<(typeof NAV_ITEMS)[number]["key"]>([
  "dashboard",
  "analyses",
  "agents",
  "cvVersions",
  "quotas",
  "applications",
]);

// A route that is both an area's own screen and the prefix of every other
// screen in it, so it can only match exactly — otherwise `/` would own every
// route, and the Admin dashboard row would stay active across the whole Admin
// area.
const EXACT_MATCH_HREFS = new Set(["/", "/admin"]);

/**
 * A nav item is active on an exact path match or when the current route is
 * nested under it, bar the {@link EXACT_MATCH_HREFS} area roots.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (EXACT_MATCH_HREFS.has(href)) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

type NavItem = { href: string; label: string; Icon: typeof LayoutDashboard };
/** One block of nav rows, under an optional heading and above a rule. */
type NavGroup = { id: string; heading?: string; items: NavItem[] };

/**
 * The Sidebar's nav rows for the signed-in role, labels already resolved: a
 * Candidate gets the one ungrouped block of {@link NAV_ITEMS}; an
 * Administrator gets the Admin sections under an "Administration" heading,
 * then Settings on its own — the per-Candidate rows being meaningless for
 * that role (see {@link ADMIN_HIDDEN_NAV_KEYS}).
 *
 * Shared with the Topbar, which resolves the current page's title from the
 * same list, so a route only ever gets a title where it also has a nav row.
 */
export function useNavGroups(): NavGroup[] {
  const t = useTranslations("nav");
  const tAdmin = useTranslations("admin.nav");
  const { data: session } = useSession();

  if (session?.user?.role !== "ADMINISTRATOR") {
    return [
      {
        id: "main",
        items: NAV_ITEMS.map(({ href, key, Icon }) => ({ href, label: t(key), Icon })),
      },
    ];
  }

  return [
    {
      id: "admin",
      heading: t("admin"),
      items: ADMIN_NAV_ITEMS.map(({ href, key, Icon }) => ({
        href,
        label: tAdmin(key),
        Icon,
      })),
    },
    {
      id: "account",
      items: NAV_ITEMS.filter((item) => !ADMIN_HIDDEN_NAV_KEYS.has(item.key)).map(
        ({ href, key, Icon }) => ({ href, label: t(key), Icon }),
      ),
    },
  ];
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
 * The nav rows, grouped by {@link useNavGroups}, with the current route
 * flagged `aria-current`. Each group after the first is set off by a rule,
 * and carries its heading when there is room for one. When `collapsed`, a row
 * shows only its icon (the label stays in the DOM as `sr-only` so the link's
 * accessible name is unchanged) and gains a Tooltip so the label is still
 * reachable on hover or focus; the headings go with the labels, the rules
 * staying behind as the only grouping left.
 */
function SidebarNav({
  onNavigate,
  collapsed,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const groups = useNavGroups();
  return (
    <nav className="flex flex-col gap-1">
      {groups.map(({ id, heading, items }, groupIndex) => (
        <div key={id} className="flex flex-col gap-0.5">
          {groupIndex > 0 && <Separator className="my-2" />}
          {heading && !collapsed && (
            <p className="px-3 pb-1 text-xs font-medium tracking-wide text-muted uppercase">
              {heading}
            </p>
          )}
          {items.map(({ href, label, Icon }) => {
            const active = isNavActive(pathname, href);
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
        </div>
      ))}
    </nav>
  );
}

/**
 * The identity label, theme control, language control, and sign-out entries
 * shared by the Sidebar's account menu and the Topbar's avatar-only
 * equivalent.
 */
function AccountMenuItems({
  name,
  align,
  side,
}: {
  name: string;
  align: "start" | "end";
  side: "top" | "bottom";
}) {
  const tMenu = useTranslations("userMenu");
  return (
    <DropdownMenuContent align={align} side={side} className="min-w-56">
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
      <AccountMenuItems name={name} align="start" side="top" />
    </DropdownMenu>
  );
}

/**
 * Avatar-only account menu rendered in the Topbar below the `md` breakpoint,
 * where the persistent {@link AppSidebar} (and the account entry inside it)
 * is hidden and only reachable by opening the drawer. Keeps sign-in identity
 * and sign out reachable from every signed-in page regardless of viewport.
 */
export function TopbarAccountMenu() {
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
          className="flex size-8 flex-none items-center justify-center rounded-full bg-accent text-xs font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {initials(user?.name, user?.email)}
        </button>
      </DropdownMenuTrigger>
      <AccountMenuItems name={name} align="end" side="bottom" />
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
        "hidden flex-none overflow-y-auto border-r border-border bg-panel md:flex md:flex-col",
        collapsed ? "w-18 p-3" : "w-64 p-4",
      )}
    >
      <SidebarContent collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
    </aside>
  );
}
