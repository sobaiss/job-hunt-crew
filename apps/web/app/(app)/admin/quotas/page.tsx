"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { useAdminPlanDefaults, useSetPlanDefaults, type AdminPlanDefault } from "@/hooks/use-admin";
import { useEnumLabel } from "@/lib/enum-labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// The three Plans this comparison always shows, side by side — this page has
// no control to add or remove a Plan column (issue #146).
const REAL_PLANS = ["FREE", "STANDARD", "PREMIUM"] as const;
const KIND_ORDER = ["ACTIVE_SCOUTS", "ANALYSES_DAILY", "ANALYSES_MONTHLY", "DOCUMENTS_DAILY"] as const;

type LimitsByKind = Record<string, number | null>;

function groupByPlan(defaults: AdminPlanDefault[]): Record<string, LimitsByKind> {
  const result: Record<string, LimitsByKind> = {};
  for (const row of defaults) {
    (result[row.plan] ??= {})[row.quotaKind] = row.limit;
  }
  return result;
}

function PlanEditForm({ plan, limits, onClose }: { plan: string; limits: LimitsByKind; onClose: () => void }) {
  const t = useTranslations("admin.quotas");
  const quotaKindLabel = useEnumLabel("quotaKind");
  const setDefaults = useSetPlanDefaults(plan);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(KIND_ORDER.map((kind) => [kind, limits[kind] == null ? "" : String(limits[kind])])),
  );

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("editTitle", { plan })}</SheetTitle>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4">
        {KIND_ORDER.map((kind) => (
          <div key={kind} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor={`${plan}-${kind}`}>
              {quotaKindLabel(kind)}
            </label>
            <Input
              id={`${plan}-${kind}`}
              className="h-9 w-32"
              placeholder={t("unlimitedPlaceholder")}
              value={drafts[kind]}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [kind]: event.target.value }))}
            />
          </div>
        ))}
        {setDefaults.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("saveError")}
          </p>
        )}
      </div>
      <SheetFooter>
        <Button
          disabled={setDefaults.isPending}
          onClick={() =>
            setDefaults.mutate(
              Object.fromEntries(
                KIND_ORDER.map((kind) => [
                  kind,
                  drafts[kind].trim() === "" ? null : Number(drafts[kind]),
                ]),
              ),
              { onSuccess: onClose },
            )
          }
        >
          {t("saveAction")}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {t("cancelAction")}
        </Button>
      </SheetFooter>
    </>
  );
}

/**
 * The Plan defaults page (issue #146): a side-by-side comparison of
 * free/standard/premium's quota ceilings, split out of the admin users
 * screen (#140's original PlanDefaultsEditor). Each column's "Modifier"
 * action opens a slide-over editing that Plan's four QuotaKind limits
 * together, saved in one bulk request.
 */
export default function AdminQuotasPage() {
  const t = useTranslations("admin.quotas");
  const nav = useTranslations("admin");
  const quotaKindLabel = useEnumLabel("quotaKind");
  const { data, isPending, isError } = useAdminPlanDefaults();
  const [editingPlan, setEditingPlan] = useState<string | null>(null);

  const byPlan = data ? groupByPlan(data.defaults) : {};

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{t("description")}</p>
        <div className="flex gap-4 pt-1">
          <Link href="/admin" className="text-sm font-medium underline">
            {nav("title")}
          </Link>
          <Link href="/admin/users" className="text-sm font-medium underline">
            {nav("users.title")}
          </Link>
        </div>
      </div>

      {isPending && <p className="text-sm text-muted">{t("loading")}</p>}
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      )}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("kindColumn")}</TableHead>
              {REAL_PLANS.map((plan) => (
                <TableHead key={plan}>{plan}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {KIND_ORDER.map((kind) => (
              <TableRow key={kind}>
                <TableCell className="font-medium">{quotaKindLabel(kind)}</TableCell>
                {REAL_PLANS.map((plan) => {
                  const limit = byPlan[plan]?.[kind] ?? null;
                  return (
                    <TableCell key={plan}>{limit == null ? t("unlimitedLabel") : limit}</TableCell>
                  );
                })}
              </TableRow>
            ))}
            <TableRow>
              <TableCell />
              {REAL_PLANS.map((plan) => (
                <TableCell key={plan}>
                  <Button size="sm" variant="outline" onClick={() => setEditingPlan(plan)}>
                    {t("modifyAction")}
                  </Button>
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      )}

      <Sheet open={editingPlan !== null} onOpenChange={(open) => !open && setEditingPlan(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {editingPlan && (
            <PlanEditForm
              plan={editingPlan}
              limits={byPlan[editingPlan] ?? {}}
              onClose={() => setEditingPlan(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
