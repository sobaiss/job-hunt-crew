import { describe, expect, it } from "vitest";

import { resolveLocale } from "@/i18n/locale";

describe("resolveLocale", () => {
  it("prefers a valid NEXT_LOCALE cookie over the Accept-Language header", () => {
    expect(resolveLocale("fr", "en-US,en;q=0.9")).toBe("fr");
  });

  it("falls back to the first supported Accept-Language entry when there is no cookie", () => {
    expect(resolveLocale(undefined, "fr-CA,fr;q=0.9,en;q=0.8")).toBe("fr");
  });

  it("ignores an unsupported cookie value and uses the header instead", () => {
    expect(resolveLocale("de", "fr;q=0.9")).toBe("fr");
  });

  it("defaults to en when neither the cookie nor the header names a supported Locale", () => {
    expect(resolveLocale(null, "de-DE,de;q=0.9")).toBe("en");
  });

  it("defaults to en when nothing is provided", () => {
    expect(resolveLocale()).toBe("en");
  });
});
