import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { SignInForm } from "./sign-in-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signIn");
  return { title: t("title") };
}

// The form reads `?callbackUrl` / `?error` with `useSearchParams()`, which Next
// requires to sit under a Suspense boundary.
export default function SignInPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8">
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
