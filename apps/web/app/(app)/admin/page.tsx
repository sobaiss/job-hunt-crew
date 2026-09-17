"use client";

import { useTranslations } from "next-intl";

import { useAdminMe } from "@/hooks/use-admin";

/**
 * The bare Admin area landing page (issue #138) — only its own gate
 * (app/(app)/admin/layout.tsx) and this page exist so far. #139/#140 add the
 * per-user and reporting screens behind the same require_admin dependency
 * this page's GET /api/admin/me call already exercises end to end.
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
    </main>
  );
}
