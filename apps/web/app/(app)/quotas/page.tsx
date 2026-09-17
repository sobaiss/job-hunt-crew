"use client";

import { useTranslations } from "next-intl";

import { useQuotas, type QuotaUsage } from "@/hooks/use-quotas";
import { Card, CardContent } from "@/components/ui/card";

// The four QuotaKinds always render, in this fixed order, regardless of how
// close to (or far from) their limit each one is (issue #141) — a Candidate
// gets a consistent, complete picture rather than only the kinds they're
// close to exhausting.
const KIND_ORDER = [
  "activeScouts",
  "analysesDaily",
  "analysesMonthly",
  "documentsDaily",
] as const;

function QuotaBar({ usage }: { usage: QuotaUsage }) {
  const t = useTranslations("quotas");
  const percent =
    usage.cap == null ? 0 : Math.min(100, Math.round((usage.used / usage.cap) * 100));

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={usage.cap ?? undefined}
        aria-valuenow={usage.cap == null ? undefined : usage.used}
        className="h-2 w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: usage.cap == null ? "0%" : `${percent}%` }}
        />
      </div>
      <p className="text-xs text-muted">
        {usage.cap == null
          ? t("usageUnlimited", { used: usage.used })
          : t("usage", { used: usage.used, cap: usage.cap })}
      </p>
    </div>
  );
}

export default function QuotasPage() {
  const t = useTranslations("quotas");
  const { data, isPending, isError } = useQuotas();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{t("description")}</p>
      </div>

      {isPending && <p className="text-sm text-muted">{t("loading")}</p>}
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("error")}
        </p>
      )}

      {data && (
        <Card>
          <CardContent className="flex flex-col gap-5 py-6">
            {KIND_ORDER.map((kind) => (
              <div key={kind} className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">{t(`kinds.${kind}`)}</p>
                <QuotaBar usage={data[kind]} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
