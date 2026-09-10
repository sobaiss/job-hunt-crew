"use client";

import { signOut, useSession } from "next-auth/react";
import { useTranslations } from "next-intl";

import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitch } from "@/components/locale-switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The one predictable place for a Candidate's preferences and account identity.
 * Theme and Locale reuse the same controls the Sidebar account menu exposes;
 * name and email come from the Session and are read-only (no BFF supports
 * editing them). Sign out mirrors the Sidebar's. The Settings nav row goes
 * active here via the shell's `isNavActive`.
 */
export default function SettingsPage() {
  const t = useTranslations("settings");
  const { data: session } = useSession();
  const user = session?.user;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-10 p-8">
      <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted">
          {t("preferences.heading")}
        </h2>
        <Card className="gap-0 py-0">
          <CardContent className="flex flex-col divide-y divide-border px-6 py-0">
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {t("preferences.themeLabel")}
                </span>
                <span className="text-xs text-muted">
                  {t("preferences.themeHint")}
                </span>
              </div>
              <ThemeToggle />
            </div>
            <div className="flex items-center justify-between gap-4 py-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {t("preferences.languageLabel")}
                </span>
                <span className="text-xs text-muted">
                  {t("preferences.languageHint")}
                </span>
              </div>
              <LocaleSwitch />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted">
          {t("account.heading")}
        </h2>
        <Card className="gap-0 py-0">
          <CardContent className="flex flex-col divide-y divide-border px-6 py-0">
            <div className="flex items-center justify-between gap-4 py-4">
              <span className="text-sm font-medium">
                {t("account.nameLabel")}
              </span>
              <span className="text-sm text-muted">
                {user?.name ?? t("account.unknown")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-4">
              <span className="text-sm font-medium">
                {t("account.emailLabel")}
              </span>
              <span className="text-sm text-muted">
                {user?.email ?? t("account.unknown")}
              </span>
            </div>
          </CardContent>
        </Card>
        <p className="text-xs text-muted">{t("account.readOnlyNote")}</p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted">{t("session.heading")}</h2>
        <div>
          <Button variant="outline" onClick={() => void signOut()}>
            {t("session.signOut")}
          </Button>
        </div>
      </section>
    </main>
  );
}
