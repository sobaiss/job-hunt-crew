"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { locales, persistLocale, type Locale } from "@/i18n/locale";

/**
 * Standalone language control. Picking a Locale writes the `NEXT_LOCALE` cookie
 * (so future requests resolve to it), mirrors it onto `<html lang>` for
 * immediate assistive-tech correctness, and refreshes so server components
 * re-render with the new catalogue.
 */
export function LocaleSwitch() {
  const t = useTranslations("locale");
  const active = useLocale();
  const router = useRouter();

  function pick(locale: Locale) {
    persistLocale(locale);
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("label")}>
          <Languages className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {locales.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => pick(locale)}
            aria-current={locale === active ? "true" : undefined}
          >
            {t(locale)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
