"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { BatchResultView } from "@/components/batch-result-view";

// The routable Batch result view for one SITE_SEARCH run. The "Analyse several
// offers" screen renders <BatchResultView> inline right after submit; this page
// is the same view reached by its own URL, so a candidate can close the tab and
// come back (#36) and the Dashboard's grouped SITE_SEARCH row has somewhere to
// link (#34).
export default function BatchResultPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("analyseSeveral");

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("heading")}</h1>
      <BatchResultView ingestionJobId={params.id} />
    </main>
  );
}
