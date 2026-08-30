// The supported UI Locales and the rules for picking one. Kept free of any
// Next.js request API so it can be unit-tested and reused on both sides.

export const locales = ["en", "fr"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

// next-intl's own default cookie name. Reusing it keeps the library's helpers
// (and its docs) applicable if we lean on them later.
export const LOCALE_COOKIE = "NEXT_LOCALE";

// One year — the choice should stick until the user changes it.
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: string | null | undefined): value is Locale {
  return value != null && (locales as readonly string[]).includes(value);
}

/**
 * Resolve the active Locale for a request. Precedence:
 *   1. an explicit `NEXT_LOCALE` cookie (the user's saved choice),
 *   2. the first supported language in the `Accept-Language` header,
 *   3. {@link defaultLocale} (`en`).
 *
 * Region subtags are ignored (`fr-CA` -> `fr`); `q` weights are taken in the
 * order the browser already sorted them into.
 */
export function resolveLocale(
  cookieValue?: string | null,
  acceptLanguage?: string | null,
): Locale {
  if (isLocale(cookieValue)) {
    return cookieValue;
  }

  for (const entry of acceptLanguage?.split(",") ?? []) {
    const tag = entry.split(";")[0]?.trim().toLowerCase();
    const base = tag?.split("-")[0];
    if (isLocale(base)) {
      return base;
    }
  }

  return defaultLocale;
}

/**
 * Client-only: save the user's Locale choice for future requests and reflect it
 * on `<html lang>` immediately (assistive tech reads that attribute). The caller
 * still refreshes the route so server components re-render with the new
 * catalogue. Lives here — outside any component — so the write stays a plain
 * side effect the React hooks lint rules don't police.
 */
export function persistLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`;
  document.documentElement.lang = locale;
}
