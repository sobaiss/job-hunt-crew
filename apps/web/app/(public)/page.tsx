import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";

// The public front door. A signed-out Visitor sees the product statement and a
// call to action; a signed-in Candidate is sent straight to the Dashboard so
// they never see the marketing page twice.
export default async function LandingPage() {
  const session = await auth();
  if (session?.user) {
    redirect("/analyses");
  }

  const t = await getTranslations("landing");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 p-8 text-center">
      <div
        aria-hidden
        className="size-16 rounded-2xl bg-accent/15 ring-1 ring-accent/30"
      />
      <div className="flex max-w-xl flex-col gap-4">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">
          {t("tagline")}
        </h1>
        <p className="text-muted">{t("description")}</p>
      </div>
      <Button asChild size="lg">
        <Link href="/sign-in">{t("signIn")}</Link>
      </Button>
    </main>
  );
}
