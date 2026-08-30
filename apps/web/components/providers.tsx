"use client";

import * as React from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";

import { Toaster } from "@/components/ui/sonner";
import { defaultLocale } from "@/i18n/locale";
import enMessages from "@/messages/en.json";

/**
 * The single client provider stack, mounted once in the root layout.
 *
 * - `SessionProvider` so client components read the NextAuth Session without
 *   each refetching `/api/auth/session`.
 * - `ThemeProvider` (next-themes, class strategy) — default `system`, no flash
 *   of the wrong theme (the blocking script it injects runs before paint;
 *   `suppressHydrationWarning` is already on `<html>` in layout.tsx).
 * - `QueryClientProvider` — one `QueryClient` per browser session, created lazily
 *   so it survives Fast Refresh but is never shared across requests on the server.
 * - `NextIntlClientProvider` — `locale` / `messages` are resolved on the server
 *   in `app/layout.tsx` and passed in. They default to `en` so the component is
 *   still usable on its own (tests, Storybook-style mounts).
 */
export function Providers({
  children,
  locale = defaultLocale,
  messages = enMessages,
}: {
  children: React.ReactNode;
  locale?: string;
  messages?: AbstractIntlMessages;
}) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <SessionProvider>
      {/* `timeZone` mirrors i18n/request.ts so client-rendered translations
          don't fall back (and warn); nothing renders zone-sensitive dates yet. */}
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <QueryClientProvider client={queryClient}>
            {children}
            <Toaster />
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>
    </SessionProvider>
  );
}
