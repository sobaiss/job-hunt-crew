"use client";

import { useTranslations } from "next-intl";

import { ScoutForm } from "@/components/scout-form";

export default function NewScoutPage() {
  const t = useTranslations("scouts.form");

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("newHeading")}</h1>
      <ScoutForm />
    </main>
  );
}
