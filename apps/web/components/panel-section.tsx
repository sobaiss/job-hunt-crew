"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/**
 * One titled block inside a slide-over panel — Configuration, Statistiques,
 * Historique des exécutions, Résultats pertinents on the Scout panel. A
 * single definition of the section chrome (icon + serif title on a ruled
 * header bar, an optional trailing slot for a count or a control, then the
 * body) so a panel's sections read as one stack instead of four ad-hoc cards.
 *
 * `title` is optional: a section that only needs the header bar for its
 * trailing control (the stats header on the Applications view, which sits
 * under that page's own <h1>) renders the bar without a heading.
 */
export function PanelSection({
  icon: Icon,
  title,
  trailing,
  children,
  className,
  bodyClassName,
}: {
  icon?: LucideIcon;
  title?: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0 shadow-xs", className)}>
      {/* `min-h-14` so a header carrying a control (the stats window toggle)
          lines up with a title-only one when two sections sit side by side. */}
      <div className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-5 py-3">
        {Icon && <Icon className="size-4 shrink-0 text-muted" aria-hidden />}
        {title && (
          <h2 className="font-serif text-lg font-semibold">{title}</h2>
        )}
        {trailing && (
          <div className="ml-auto flex items-center gap-2">{trailing}</div>
        )}
      </div>
      <div className={cn("px-5 py-4 text-sm", bodyClassName)}>{children}</div>
    </Card>
  );
}

/** The "nothing here yet" body of a `PanelSection` — a dashed well rather
 *  than a bare muted sentence, so an empty section still reads as a section. */
export function PanelEmptyState({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
      <Icon className="size-5 opacity-60" aria-hidden />
      <p>{children}</p>
    </div>
  );
}
