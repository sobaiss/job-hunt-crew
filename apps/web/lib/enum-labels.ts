"use client";

import { useTranslations } from "next-intl";

// The server keeps sending raw enum values (`PENDING`, `COMPLETED`, …); this is
// the one place they become Locale-aware labels, at render time. Add a matching
// key set under `enum.<namespace>` in the message catalogues for each enum.
type EnumNamespace =
  | "analysisStatus"
  | "ingestionStatus"
  | "cvConversionStatus";

/**
 * Returns a `label(value)` function for one server enum. An unmapped value
 * (e.g. a status added to the API but not yet to the catalogues) falls back to
 * the raw string rather than rendering blank.
 */
export function useEnumLabel(namespace: EnumNamespace): (value: string) => string {
  const t = useTranslations(`enum.${namespace}`);
  return (value: string) => (t.has(value) ? t(value) : value);
}
