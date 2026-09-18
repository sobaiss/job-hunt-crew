import { describe, expect, it } from "vitest";
import type { Session } from "next-auth";
import { adminSessionHeaders } from "@/lib/internal-api";

// Issue #152: every admin BFF route built its X-User-Id/X-User-Is-Admin pair
// inline. This is the single shared place that construction now happens, so
// the later Role rollout (#156) only needs to change this one function.
describe("adminSessionHeaders", () => {
  it("returns null when there is no authenticated user", () => {
    expect(adminSessionHeaders(null)).toBeNull();
    expect(adminSessionHeaders({ user: {} } as Session)).toBeNull();
  });

  it("builds X-User-Id and X-User-Is-Admin=true for an admin session", () => {
    const session = { user: { id: "user-1", isAdmin: true } } as Session;
    expect(adminSessionHeaders(session)).toEqual({
      "X-User-Id": "user-1",
      "X-User-Is-Admin": "true",
    });
  });

  it("builds X-User-Is-Admin=false for a non-admin session", () => {
    const session = { user: { id: "user-2", isAdmin: false } } as Session;
    expect(adminSessionHeaders(session)).toEqual({
      "X-User-Id": "user-2",
      "X-User-Is-Admin": "false",
    });
  });

  it("defaults X-User-Is-Admin to false when isAdmin is undefined", () => {
    const session = { user: { id: "user-3" } } as Session;
    expect(adminSessionHeaders(session)).toEqual({
      "X-User-Id": "user-3",
      "X-User-Is-Admin": "false",
    });
  });
});
