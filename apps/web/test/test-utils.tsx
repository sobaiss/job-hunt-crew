import type { ReactElement, ReactNode } from "react";
import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { Session } from "next-auth";

import type { Locale } from "@/i18n/locale";
import enMessages from "@/messages/en.json";
import frMessages from "@/messages/fr.json";

const MESSAGES: Record<Locale, typeof enMessages> = {
  en: enMessages,
  fr: frMessages,
};

// The shared entry point for component/integration tests. It mounts the same
// provider stack as `components/providers.tsx` (Session + i18n + theme +
// QueryClient) so page tests get the full context in one call. `session`,
// `theme` and `locale` are settable per test.
type ProviderOptions = {
  session?: Session | null;
  theme?: string;
  locale?: Locale;
};

export function renderWithProviders(
  ui: ReactElement,
  {
    session = null,
    theme = "light",
    locale = "en",
    ...options
  }: Omit<RenderOptions, "wrapper"> & ProviderOptions = {},
): RenderResult {
  // A fresh client per render: no retries (so error states surface immediately)
  // and no cross-test cache bleed.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SessionProvider session={session}>
        <NextIntlClientProvider
          locale={locale}
          messages={MESSAGES[locale]}
          timeZone="UTC"
        >
          <ThemeProvider attribute="class" defaultTheme={theme} enableSystem>
            <QueryClientProvider client={queryClient}>
              {children}
            </QueryClientProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </SessionProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...options });
}

export * from "@testing-library/react";
