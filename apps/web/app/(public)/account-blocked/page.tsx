import type { Metadata } from "next";
import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("accountBlocked");
  return { title: t("title") };
}

// Where a blocked Candidate lands after `lib/bff-client.ts` signs them out on
// the first rejected request (issue #144, docs/adr/0016). Public — reached
// with no session, so it must not sit behind proxy.ts's matcher.
export default async function AccountBlockedPage() {
  const t = await getTranslations("accountBlocked");
  const tApp = await getTranslations("app");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <Link
        href="/"
        className="flex items-center gap-2 font-serif text-base font-semibold tracking-tight"
      >
        {tApp("name")}
      </Link>
      <ShieldOff className="size-10 text-destructive" aria-hidden="true" />
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{t("body")}</p>
      </div>
      <Link
        href="/"
        className="text-sm font-medium text-accent underline underline-offset-4"
      >
        {t("backToHome")}
      </Link>
    </main>
  );
}
