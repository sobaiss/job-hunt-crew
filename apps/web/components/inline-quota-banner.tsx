"use client";

import { useTranslations } from "next-intl";

import { useQuotas, type QuotaKindName } from "@/hooks/use-quotas";

// Shows on the exact screen where a blocked action lives (Scout-create form,
// /analyses/new, document generation — issue #142's AC), so the reason an
// action is about to fail is obvious in the moment rather than only in the
// notification feed. Renders nothing until the caller's own QuotaKind(s) are
// actually at their limit (`remaining === 0`); `null`/positive `remaining`
// (including unlimited) render nothing.
export function InlineQuotaBanner({ kinds }: { kinds: QuotaKindName[] }) {
  const t = useTranslations("quotas");
  const { data } = useQuotas();
  if (!data) return null;

  const blocked = kinds.find((kind) => data[kind].remaining === 0);
  if (!blocked) return null;

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {t("blocked", { kind: t(`kinds.${blocked}`) })}
    </div>
  );
}
