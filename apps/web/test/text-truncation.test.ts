import { describe, expect, it } from "vitest";

import {
  SHORT_FIELD_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  truncate,
} from "@/lib/text-truncation";

describe("truncate", () => {
  it("leaves a value under the limit unchanged", () => {
    expect(truncate("Ingénieur", 15)).toEqual({
      text: "Ingénieur",
      truncated: false,
    });
  });

  it("leaves a value exactly at the limit unchanged", () => {
    const text = "a".repeat(15);
    expect(truncate(text, 15)).toEqual({ text, truncated: false });
  });

  it("cuts a value one character over the limit and appends an ellipsis", () => {
    const text = "a".repeat(16);
    expect(truncate(text, 15)).toEqual({
      text: `${"a".repeat(15)}…`,
      truncated: true,
    });
  });

  it("handles an empty string", () => {
    expect(truncate("", 15)).toEqual({ text: "", truncated: false });
  });

  it("exposes the per-field length constants used across the app", () => {
    expect(TITLE_MAX_LENGTH).toBe(50);
    expect(SHORT_FIELD_MAX_LENGTH).toBe(15);
  });
});
