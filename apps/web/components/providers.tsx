"use client";

import * as React from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Toaster } from "@/components/ui/sonner";

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
 *
 * The next-intl provider joins this stack in ticket #6.
 */
export function Providers({ children }: { children: React.ReactNode }) {
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
    </SessionProvider>
  );
}
