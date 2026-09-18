"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useAdminMe, useAdminStats, type AdminStatsPeriod } from "@/hooks/use-admin";
import { Card, CardContent } from "@/components/ui/card";

const PERIODS: AdminStatsPeriod[] = ["7d", "30d", "90d", "all"];

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * The Admin dashboard (issue #145): global platform stats only. Every
 * figure here reflects today except `newSignups`, the only one filtered by
 * `period` — that split is enforced entirely server-side (services/api's
 * `/v1/admin/stats`), this page just renders whatever it's given.
 */
export default function AdminPage() {
  const t = useTranslations("admin");
  const { data: me, isPending: mePending, isError: meError } = useAdminMe();
  const [period, setPeriod] = useState<AdminStatsPeriod>("all");
  const { data: stats, isPending: statsPending, isError: statsError } = useAdminStats(period);

  const figures: Array<[string, number]> = stats
    ? [
        [t("dashboard.totalUsers"), stats.totalUsers],
        [t("dashboard.usersOverLimitCount"), stats.usersOverLimitCount],
        [t("dashboard.analysesRequestedToday"), stats.analysesRequestedToday],
        [t("dashboard.analysesRequestedThisMonth"), stats.analysesRequestedThisMonth],
        [t("dashboard.documentsCreatedToday"), stats.documentsCreatedToday],
        [t("dashboard.activeScoutsTotal"), stats.activeScoutsTotal],
        [t("dashboard.blockedUsersCount"), stats.blockedUsersCount],
      ]
    : [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{t("description")}</p>
      </div>

      {mePending && <p className="text-sm text-muted">{t("loading")}</p>}
      {meError && (
        <p role="alert" className="text-sm text-destructive">
          {t("error")}
        </p>
      )}
      {me && <p className="text-sm text-muted">{t("signedInAs", { userId: me.userId, plan: me.plan })}</p>}

      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/admin/users" className="font-medium underline">
          {t("users.title")}
        </Link>
        <Link href="/admin/quotas" className="font-medium underline">
          {t("quotas.title")}
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="admin-dashboard-period" className="text-sm text-muted">
          {t("dashboard.periodLabel")}
        </label>
        <select
          id="admin-dashboard-period"
          className={SELECT_CLASS}
          value={period}
          onChange={(event) => setPeriod(event.target.value as AdminStatsPeriod)}
        >
          {PERIODS.map((value) => (
            <option key={value} value={value}>
              {t(`dashboard.period.${value}`)}
            </option>
          ))}
        </select>
      </div>

      {statsPending && <p className="text-sm text-muted">{t("dashboard.loading")}</p>}
      {statsError && (
        <p role="alert" className="text-sm text-destructive">
          {t("dashboard.loadError")}
        </p>
      )}

      {stats && (
        <>
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 py-6 sm:grid-cols-3">
              {figures.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1">
                  <p className="text-xs text-muted">{label}</p>
                  <p className="text-lg font-semibold">{value}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">{t("dashboard.newSignupsTitle")}</h2>
            {stats.newSignups.length === 0 ? (
              <p className="text-sm text-muted">{t("dashboard.newSignupsEmpty")}</p>
            ) : (
              <Card>
                <CardContent className="h-48 py-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stats.newSignups}>
                      <XAxis dataKey="date" hide />
                      <YAxis width={28} tick={{ fontSize: 11 }} allowDecimals={false} stroke="var(--color-muted)" />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="count"
                        stroke="var(--color-success)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">{t("dashboard.usersByPlanTitle")}</h2>
            <Card>
              <CardContent className="grid grid-cols-2 gap-4 py-6 sm:grid-cols-4">
                {Object.entries(stats.usersByPlan).map(([plan, count]) => (
                  <div key={plan} className="flex flex-col gap-1">
                    <p className="text-xs text-muted">{plan}</p>
                    <p className="text-lg font-semibold">{count}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </main>
  );
}
