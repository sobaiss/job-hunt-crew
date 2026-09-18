"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { useAdminMe } from "@/hooks/use-admin";

/**
 * The bare Admin area landing page (issue #138), now linking into the
 * reporting screen (issue #140) — the per-user detail screen (#139) is
 * reached from there rather than linked here directly, since it needs a
 * known user id.
 */
export default function AdminPage() {
  const t = useTranslations("admin");
  const { data, isPending, isError } = useAdminMe();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted">{t("description")}</p>
      {isPending && <p className="text-sm text-muted">{t("loading")}</p>}
      {isError && <p className="text-sm text-destructive">{t("error")}</p>}
      {data && (
        <p className="text-sm text-muted">
          {t("signedInAs", { userId: data.userId, plan: data.plan })}
        </p>
      )}
      <Link href="/admin/users" className="text-sm font-medium underline">
        {t("users.title")}
      </Link>
      <Link href="/admin/quotas" className="text-sm font-medium underline">
        {t("quotas.title")}
      </Link>
    </main>
  );
}
