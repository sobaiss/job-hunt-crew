"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import {
  SUBNAV_ACTIVE_CLASS,
  SUBNAV_CLASS,
  SUBNAV_LINK_CLASS,
} from "@/components/matching-subnav";

// The six screens of the Admin area, in tab order. "Plan defaults" lives at
// /admin/quotas (issue #146).
export const ADMIN_TABS = [
  { href: "/admin", key: "dashboard" },
  { href: "/admin/users", key: "users" },
  { href: "/admin/quotas", key: "planDefaults" },
  { href: "/admin/analyses", key: "analyses" },
  { href: "/admin/scouts", key: "scouts" },
  { href: "/admin/cv-versions", key: "cvVersions" },
] as const;

// `/admin` is the Dashboard's own route and the prefix of every other tab, so
// it only matches exactly; the others also own their nested routes.
function isTabActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The shared tab strip on every Admin-area screen (issue #164): links all six
 * screens and flags the current one with `aria-current`. Mounted by
 * `app/(app)/admin/layout.tsx`, behind its Administrator gate, so it never
 * renders for anyone else.
 */
export function AdminTabs() {
  const t = useTranslations("admin.nav");
  const pathname = usePathname();
  return (
    <nav aria-label={t("label")} className={cn(SUBNAV_CLASS, "max-w-full flex-wrap")}>
      {ADMIN_TABS.map(({ href, key }) => {
        const active = isTabActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={active ? SUBNAV_ACTIVE_CLASS : SUBNAV_LINK_CLASS}
          >
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
