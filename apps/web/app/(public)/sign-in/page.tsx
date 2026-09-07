import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { SignInForm } from "./sign-in-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signIn");
  return { title: t("title") };
}

// The form reads `?callbackUrl` / `?error` with `useSearchParams()`, which Next
// requires to sit under a Suspense boundary. Restyled to the new system: the
// brand mark and a back link frame the card, the behaviour is unchanged.
export default async function SignInPage() {
  const t = await getTranslations("signIn");
  const tApp = await getTranslations("app");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <Link
        href="/"
        className="flex items-center gap-2 font-serif text-base font-semibold tracking-tight"
      >
        <svg aria-hidden="true" viewBox="0 0 28 28" className="size-6 text-accent">
          <rect
            x="1.5"
            y="1.5"
            width="25"
            height="25"
            rx="7"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <circle
            cx="14"
            cy="14"
            r="7"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
          />
          <circle cx="14" cy="14" r="2.6" fill="currentColor" />
          <path
            d="M14 3.2v3.2M14 21.6v3.2M24.8 14h-3.2M6.4 14H3.2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {tApp("name")}
      </Link>

      <Suspense>
        <SignInForm />
      </Suspense>

      <Link
        href="/"
        className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("backToHome")}
      </Link>
    </main>
  );
}
