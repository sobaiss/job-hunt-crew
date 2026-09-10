"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { useScout } from "@/hooks/use-scouts";
import { ScoutForm } from "@/components/scout-form";
import { Skeleton } from "@/components/ui/skeleton";

export default function EditScoutPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("scouts");

  const { data: scout, isPending, isError } = useScout(params.id);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <h1 className="font-serif text-2xl font-semibold">
        {t("form.editHeading")}
      </h1>

      {isPending && (
        <div role="status" aria-label={t("detail.loading")}>
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {(isError || (!isPending && !scout)) && (
        <p role="alert" className="text-sm text-destructive">
          {t("detail.loadError")}
        </p>
      )}

      {scout && <ScoutForm scout={scout} />}

      <Link href={`/scouts/${params.id}`} className="text-sm text-accent underline">
        {t("detail.back")}
      </Link>
    </main>
  );
}
