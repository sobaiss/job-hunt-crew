import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { LOCALE_COOKIE, resolveLocale } from "./locale";

// Called by next-intl (via the plugin in next.config.ts) once per request.
// There is no `[locale]` URL segment — the active Locale comes from the saved
// cookie, then `Accept-Language`, then `en`.
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);

  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );

  return {
    locale,
    // A fixed zone keeps server and client markup identical (next-intl warns
    // otherwise). Nothing renders zone-sensitive dates today; revisit if a
    // page needs the candidate's local time.
    timeZone: "UTC",
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
