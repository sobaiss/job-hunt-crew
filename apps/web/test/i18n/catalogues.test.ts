import { describe, expect, it } from "vitest";

import enMessages from "@/messages/en.json";
import frMessages from "@/messages/fr.json";

function flatKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) =>
      flatKeys(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort();
}

describe("message catalogues", () => {
  it("en and fr define exactly the same keys", () => {
    expect(flatKeys(frMessages)).toEqual(flatKeys(enMessages));
  });

  it("has no empty strings", () => {
    const values = JSON.stringify(enMessages) + JSON.stringify(frMessages);
    expect(values).not.toMatch(/:\s*""/);
  });
});
