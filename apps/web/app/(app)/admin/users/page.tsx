"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  useAdminPlanDefaults,
  useAdminStats,
  useAdminUsers,
  useSetPlanDefault,
} from "@/hooks/use-admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const KIND_ORDER = [
  "ACTIVE_SCOUTS",
  "ANALYSES_DAILY",
  "ANALYSES_MONTHLY",
  "DOCUMENTS_DAILY",
] as const;

function StatsPanel() {
  const t = useTranslations("admin.users.stats");
  const { data, isPending, isError } = useAdminStats();

  if (isPending) return <p className="text-sm text-muted">{t("loading")}</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  const rows: Array<[string, number]> = [
    [t("totalUsers"), data.totalUsers],
    [t("usersOverLimitCount"), data.usersOverLimitCount],
    [t("analysesRequestedToday"), data.analysesRequestedToday],
    [t("analysesRequestedThisMonth"), data.analysesRequestedThisMonth],
    [t("documentsCreatedToday"), data.documentsCreatedToday],
    [t("activeScoutsTotal"), data.activeScoutsTotal],
  ];

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 py-6 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PlanDefaultRow({ plan, kind, limit }: { plan: string; kind: string; limit: number | null }) {
  const t = useTranslations("admin.users.planDefaults");
  const [draft, setDraft] = useState(limit == null ? "" : String(limit));
  const setDefault = useSetPlanDefault();
  const label = `${plan} / ${kind}`;

  return (
    <div className="flex items-center gap-2">
      <span className="w-56 text-sm">{label}</span>
      <Input
        aria-label={label}
        className="h-8 w-24"
        placeholder={t("unlimitedPlaceholder")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={setDefault.isPending}
        onClick={() =>
          setDefault.mutate({ plan, kind, limit: draft.trim() === "" ? null : Number(draft) })
        }
      >
        {t("save", { label })}
      </Button>
    </div>
  );
}

function PlanDefaultsEditor() {
  const t = useTranslations("admin.users.planDefaults");
  const { data, isPending, isError } = useAdminPlanDefaults();

  if (isPending) return <p className="text-sm text-muted">{t("loading")}</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-6">
        {data.defaults.map((row) => (
          <PlanDefaultRow
            key={`${row.plan}:${row.quotaKind}`}
            plan={row.plan}
            kind={row.quotaKind}
            limit={row.limit}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function UsersTable({ atOrOverLimit }: { atOrOverLimit: boolean }) {
  const t = useTranslations("admin.users.table");
  const { data, isPending, isError } = useAdminUsers(atOrOverLimit);

  if (isPending) return <p className="text-sm text-muted">{t("loading")}</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {data.users.map((user) => (
        <Link
          key={user.userId}
          href={`/admin/users/${user.userId}`}
          className="flex flex-col gap-2 rounded-md border border-border p-3 hover:bg-accent/5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{user.userId}</span>
            <span className="text-xs text-muted">
              {user.email ?? t("noEmail")} · {user.plan}
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            {KIND_ORDER.map((kind) => {
              const usage = user.quotas[kind];
              return (
                <span key={kind} className="text-xs text-muted">
                  {kind}: {usage.used}
                  {usage.cap == null ? "" : `/${usage.cap}`}
                </span>
              );
            })}
            {user.atOrOverLimit && (
              <span className="text-xs font-medium text-destructive">{t("atOrOverLimit")}</span>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

/**
 * The admin reporting screen (issue #140): global aggregate usage stats, a
 * per-user table (with an at/over-any-limit filter) linking into #139's
 * per-user detail screen, and the Plan-defaults editor. Editing a default
 * here takes effect for every non-overridden User on that Plan on their very
 * next `effective_quota` read — no backfill, no re-fetch needed on this page.
 */
export default function AdminUsersPage() {
  const t = useTranslations("admin.users");
  const [atOrOverLimit, setAtOrOverLimit] = useState(false);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{t("description")}</p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("stats.title")}</h2>
        <StatsPanel />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("planDefaults.title")}</h2>
        <PlanDefaultsEditor />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t("table.title")}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={atOrOverLimit}
            onChange={(event) => setAtOrOverLimit(event.target.checked)}
            aria-label={t("table.filterLabel")}
          />
          {t("table.filterLabel")}
        </label>
        <UsersTable atOrOverLimit={atOrOverLimit} />
      </section>
    </main>
  );
}
