"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bot, FileText, ListChecks, Users } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useAdminStats, type AdminStats, type AdminStatsPeriod } from "@/hooks/use-admin";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PERIODS: AdminStatsPeriod[] = ["7d", "30d", "90d", "all"];

const SELECT_CLASS =
  "flex h-8 w-auto rounded-md border border-border bg-background px-2 py-1 text-xs shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

// The Plans in the order the Plan defaults screen compares them, so the two
// screens read the same way round. A Plan the server reports outside this list
// still shows, sorted after these.
const PLAN_ORDER = ["FREE", "STANDARD", "PREMIUM"];

/** A signup-series tick as a short "12 Jan"-style label. */
function shortDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/**
 * One headline figure. Given an `href` the whole tile is the link into the
 * Admin section that figure comes from — the figures with no section of their
 * own (documents) render as a plain tile instead.
 */
function StatTile({
  label,
  value,
  sub,
  Icon,
  href,
}: {
  label: string;
  value: number;
  sub?: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  href?: string;
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted">{label}</span>
        <Icon className="size-4 flex-none text-muted" aria-hidden={true} />
      </span>
      <span className="font-serif text-3xl font-semibold tabular-nums">{value}</span>
      {/* A non-breaking space keeps a tile with no caption the same height as
          its neighbours, so the row of values stays on one baseline. */}
      <span className="truncate text-xs text-muted">{sub ?? " "}</span>
    </>
  );

  const content = "flex flex-col gap-1 rounded-xl px-5 py-4";
  return (
    <Card className="gap-0 py-0">
      {href ? (
        <Link
          href={href}
          className={cn(
            content,
            "transition-colors outline-none hover:bg-panel/60 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={content}>{body}</div>
      )}
    </Card>
  );
}

/** A Card with a serif heading and an optional control on the heading row. */
function PanelCard({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-4 py-5", className)}>
      <CardContent className="flex flex-col gap-4">
        {/* Wraps rather than squeezing the heading: at phone width the control
            drops onto its own line instead of forcing the title to two. */}
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 className="font-serif text-base font-semibold">{title}</h2>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Recharts' stock tooltip is a hard-coded white box, which disappears against
 * the dark palette — this renders the same content on the popover tokens
 * instead.
 */
function ChartTooltip({
  active,
  payload,
  label,
  seriesLabel,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
  seriesLabel: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="text-xs text-muted">{label ? shortDate(label) : ""}</p>
      <p className="text-sm font-medium tabular-nums">
        {payload[0]?.value} · {seriesLabel}
      </p>
    </div>
  );
}

/** The Plan split as a labelled share bar per Plan, widest share first. */
function UsersByPlan({ usersByPlan }: { usersByPlan: AdminStats["usersByPlan"] }) {
  const t = useTranslations("admin.dashboard");
  const rows = Object.entries(usersByPlan).sort(([a], [b]) => {
    const rank = (plan: string) => {
      const index = PLAN_ORDER.indexOf(plan);
      return index === -1 ? PLAN_ORDER.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const total = rows.reduce((sum, [, count]) => sum + count, 0);

  if (total === 0) {
    return <p className="text-sm text-muted">{t("usersByPlanEmpty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map(([plan, count]) => {
        const share = Math.round((count / total) * 100);
        return (
          <li key={plan} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{plan}</span>
              <span className="text-sm tabular-nums text-muted">
                {count} · {share}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel">
              <div
                className="h-full rounded-full bg-foreground/60"
                style={{ width: `${share}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A count that only wants attention above zero: tinted when it is, muted when not. */
function AttentionRow({
  label,
  value,
  href,
  variant,
}: {
  label: string;
  value: number;
  href: string;
  variant: "warning" | "danger";
}) {
  return (
    <li>
      <Link
        href={href}
        className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-panel/60"
      >
        <span className="text-sm">{label}</span>
        <Badge variant={value > 0 ? variant : "muted"} className="tabular-nums">
          {value}
        </Badge>
      </Link>
    </li>
  );
}

/**
 * The Admin dashboard (issue #145): global platform stats only. Every figure
 * here reflects today except `newSignups`, the only one filtered by `period`
 * — that split is enforced entirely server-side (services/api's
 * `/v1/admin/stats`), this page just renders whatever it's given, which is
 * why the period control sits in the signups panel rather than over the page:
 * it is the only thing it changes.
 *
 * Navigation out of here is the Sidebar's job (components/app-sidebar.tsx's
 * ADMIN_NAV_ITEMS); what this page adds is a way in to the section behind a
 * figure that warrants a closer look.
 */
export default function AdminPage() {
  const t = useTranslations("admin");
  const tDash = useTranslations("admin.dashboard");
  const [period, setPeriod] = useState<AdminStatsPeriod>("all");
  const { data: stats, isPending: statsPending, isError: statsError } = useAdminStats(period);

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{tDash("description")}</p>
      </div>

      {statsPending && (
        <div
          role="status"
          aria-label={tDash("loading")}
          className="flex flex-col gap-6"
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        </div>
      )}

      {statsError && (
        <p role="alert" className="text-sm text-destructive">
          {tDash("loadError")}
        </p>
      )}

      {stats && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label={tDash("totalUsers")}
              value={stats.totalUsers}
              Icon={Users}
              href="/admin/users"
            />
            <StatTile
              label={tDash("analysesRequestedToday")}
              value={stats.analysesRequestedToday}
              sub={tDash("analysesMonthSub", { count: stats.analysesRequestedThisMonth })}
              Icon={ListChecks}
              href="/admin/analyses"
            />
            <StatTile
              label={tDash("activeScoutsTotal")}
              value={stats.activeScoutsTotal}
              Icon={Bot}
              href="/admin/scouts"
            />
            <StatTile
              label={tDash("documentsCreatedToday")}
              value={stats.documentsCreatedToday}
              Icon={FileText}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <PanelCard
              title={tDash("newSignupsTitle")}
              action={
                <>
                  <label htmlFor="admin-dashboard-period" className="sr-only">
                    {tDash("periodLabel")}
                  </label>
                  <select
                    id="admin-dashboard-period"
                    className={SELECT_CLASS}
                    value={period}
                    onChange={(event) => setPeriod(event.target.value as AdminStatsPeriod)}
                  >
                    {PERIODS.map((value) => (
                      <option key={value} value={value}>
                        {tDash(`period.${value}`)}
                      </option>
                    ))}
                  </select>
                </>
              }
            >
              {stats.newSignups.length === 0 ? (
                <p className="text-sm text-muted">{tDash("newSignupsEmpty")}</p>
              ) : (
                <>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={stats.newSignups} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="admin-signups-fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--color-success)" stopOpacity={0.28} />
                            <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          vertical={false}
                          stroke="var(--color-border)"
                          strokeDasharray="3 3"
                        />
                        <XAxis
                          dataKey="date"
                          tickFormatter={shortDate}
                          tick={{ fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={24}
                          stroke="var(--color-muted)"
                        />
                        <YAxis
                          width={28}
                          tick={{ fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                          allowDecimals={false}
                          stroke="var(--color-muted)"
                        />
                        <Tooltip
                          cursor={{ stroke: "var(--color-border)" }}
                          content={<ChartTooltip seriesLabel={tDash("newSignupsTitle")} />}
                        />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke="var(--color-success)"
                          strokeWidth={2}
                          fill="url(#admin-signups-fill)"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="text-xs text-muted">
                    {tDash("newSignupsTotal", {
                      count: stats.newSignups.reduce((sum, point) => sum + point.count, 0),
                    })}
                  </p>
                </>
              )}
            </PanelCard>

            <div className="flex flex-col gap-5">
              <PanelCard title={tDash("usersByPlanTitle")}>
                <UsersByPlan usersByPlan={stats.usersByPlan} />
              </PanelCard>

              <PanelCard title={tDash("attentionTitle")}>
                <ul className="flex flex-col gap-1">
                  <AttentionRow
                    label={tDash("usersOverLimitCount")}
                    value={stats.usersOverLimitCount}
                    href="/admin/quotas"
                    variant="warning"
                  />
                  <AttentionRow
                    label={tDash("blockedUsersCount")}
                    value={stats.blockedUsersCount}
                    href="/admin/users"
                    variant="danger"
                  />
                </ul>
              </PanelCard>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
