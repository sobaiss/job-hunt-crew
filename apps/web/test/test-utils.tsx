import type { ReactElement, ReactNode } from "react";
import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "next-auth";

// The shared entry point for component/integration tests. It mounts the same
// provider stack as `components/providers.tsx` (Session + theme + QueryClient)
// so page tests get the full context in one call. `session` and `theme` are
// settable per test; the next-intl Locale is added here in ticket #6.
type ProviderOptions = {
  session?: Session | null;
  theme?: string;
};

export function renderWithProviders(
  ui: ReactElement,
  {
    session = null,
    theme = "light",
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
        <ThemeProvider attribute="class" defaultTheme={theme} enableSystem>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </ThemeProvider>
      </SessionProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...options });
}

export * from "@testing-library/react";
