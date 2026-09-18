import { describe, expect, it } from "vitest";
import type { Session } from "next-auth";
import { adminSessionHeaders } from "@/lib/internal-api";

// Issue #152: every admin BFF route built its X-User-Id/X-User-Role pair
// inline. This is the single shared place that construction happens; issue
// #156 changed it from a boolean X-User-Is-Admin flag to a three-value Role.
describe("adminSessionHeaders", () => {
  it("returns null when there is no authenticated user", () => {
    expect(adminSessionHeaders(null)).toBeNull();
    expect(adminSessionHeaders({ user: {} } as Session)).toBeNull();
  });

  it("builds X-User-Id and X-User-Role for an administrator session", () => {
    const session = { user: { id: "user-1", role: "ADMINISTRATOR" } } as Session;
    expect(adminSessionHeaders(session)).toEqual({
      "X-User-Id": "user-1",
      "X-User-Role": "ADMINISTRATOR",
    });
  });

  it("builds X-User-Role for an external session", () => {
    const session = { user: { id: "user-2", role: "EXTERNAL" } } as Session;
    expect(adminSessionHeaders(session)).toEqual({
      "X-User-Id": "user-2",
      "X-User-Role": "EXTERNAL",
    });
  });

  it("defaults X-User-Role to EXTERNAL when role is undefined", () => {
    const session = { user: { id: "user-3" } } as Session;
    expect(adminSessionHeaders(session)).toEqual({
      "X-User-Id": "user-3",
      "X-User-Role": "EXTERNAL",
    });
  });
});
