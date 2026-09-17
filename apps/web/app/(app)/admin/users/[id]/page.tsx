"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  useAdminUserQuotas,
  useClearQuotaOverride,
  useSetQuotaOverride,
  useSetUserPlan,
} from "@/hooks/use-admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const SELECT_CLASS =
  "flex h-9 w-auto rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

const PLAN_VALUES = ["FREE", "STANDARD", "PREMIUM", "ADMINISTRATEUR"] as const;

const KIND_ORDER = [
  "ACTIVE_SCOUTS",
  "ANALYSES_DAILY",
  "ANALYSES_MONTHLY",
  "DOCUMENTS_DAILY",
] as const;

function OverrideEditor({
  userId,
  kind,
  cap,
  hasOverride,
}: {
  userId: string;
  kind: string;
  cap: number | null;
  hasOverride: boolean;
}) {
  const t = useTranslations("admin.userDetail");
  const [draft, setDraft] = useState(cap == null ? "" : String(cap));
  const setOverride = useSetQuotaOverride(userId);
  const clearOverride = useClearQuotaOverride(userId);

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t("overrideInputLabel", { kind })}
        className="h-8 w-24"
        placeholder={t("unlimitedPlaceholder")}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={setOverride.isPending}
        onClick={() =>
          setOverride.mutate({ kind, limit: draft.trim() === "" ? null : Number(draft) })
        }
      >
        {t("setOverride")}
      </Button>
      {hasOverride && (
        <Button
          size="sm"
          variant="ghost"
          disabled={clearOverride.isPending}
          onClick={() => clearOverride.mutate(kind)}
        >
          {t("clearOverride")}
        </Button>
      )}
    </div>
  );
}

/**
 * The admin per-user detail screen (issue #139): a target User's Plan,
 * Effective quota + usage per QuotaKind, which QuotaKinds carry an explicit
 * QuotaOverride, and controls to set/clear an override or reassign the
 * User's Plan — every mutation takes effect on that User's very next
 * enforcement check since `effective_quota` always resolves live.
 */
export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("admin.userDetail");
  const { data, isPending, isError } = useAdminUserQuotas(params.id);
  const setPlan = useSetUserPlan(params.id);

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p className="text-sm text-muted">{t("loading")}</p>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="mx-auto w-full max-w-2xl p-8">
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl font-semibold">{t("title", { userId: data.userId })}</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">{t("planLabel")}</span>
          <select
            className={SELECT_CLASS}
            aria-label={t("planLabel")}
            value={data.plan}
            disabled={setPlan.isPending}
            onChange={(event) => setPlan.mutate(event.target.value)}
          >
            {PLAN_VALUES.map((plan) => (
              <option key={plan} value={plan}>
                {plan}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-5 py-6">
          {KIND_ORDER.map((kind) => {
            const usage = data.quotas[kind];
            return (
              <div key={kind} className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">{kind}</p>
                <p className="text-xs text-muted">
                  {usage.cap == null
                    ? t("usageUnlimited", { used: usage.used })
                    : t("usage", { used: usage.used, cap: usage.cap, remaining: usage.remaining ?? 0 })}
                  {usage.hasOverride ? ` · ${t("overrideActive")}` : ""}
                </p>
                <OverrideEditor
                  userId={data.userId}
                  kind={kind}
                  cap={usage.cap}
                  hasOverride={usage.hasOverride}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>
    </main>
  );
}
