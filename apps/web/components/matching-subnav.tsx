// The segmented sub-nav shared by the two analysis-entry screens ("Analyse one
// offer" / "Analyse several offers") so they read as one control in the new
// system. Each page renders its own <nav> — the current screen as a plain
// <span aria-current="page">, the other as a <Link> — using these class names.
export const SUBNAV_CLASS =
  "flex w-fit gap-1 rounded-lg border border-border bg-muted/10 p-1 text-sm";
export const SUBNAV_ACTIVE_CLASS =
  "rounded-md bg-background px-3 py-1.5 font-medium shadow-xs";
export const SUBNAV_LINK_CLASS =
  "rounded-md px-3 py-1.5 text-muted transition-colors hover:text-foreground";
