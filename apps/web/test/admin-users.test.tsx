import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import AdminUsersPage from "@/app/(app)/admin/users/page";

function statsResponse(overrides: Record<string, unknown> = {}) {
  return {
    totalUsers: 3,
    usersOverLimitCount: 1,
    analysesRequestedToday: 5,
    analysesRequestedThisMonth: 40,
    documentsCreatedToday: 2,
    activeScoutsTotal: 4,
    ...overrides,
  };
}

function usersResponse(overrides: Record<string, unknown> = {}) {
  return {
    users: [
      {
        userId: "user-1",
        email: "user1@example.com",
        plan: "FREE",
        quotas: {
          ACTIVE_SCOUTS: { cap: 2, used: 1, remaining: 1, hasOverride: false },
          ANALYSES_DAILY: { cap: 15, used: 15, remaining: 0, hasOverride: false },
          ANALYSES_MONTHLY: { cap: 300, used: 15, remaining: 285, hasOverride: false },
          DOCUMENTS_DAILY: { cap: 5, used: 0, remaining: 5, hasOverride: false },
        },
        atOrOverLimit: true,
      },
    ],
    ...overrides,
  };
}

function planDefaultsResponse() {
  return {
    defaults: [
      { plan: "FREE", quotaKind: "ANALYSES_DAILY", limit: 15 },
      { plan: "STANDARD", quotaKind: "ANALYSES_DAILY", limit: 50 },
    ],
  };
}

describe("AdminUsersPage", () => {
  it("renders global stats, the user table, and the plan-defaults editor", async () => {
    server.use(
      http.get("/api/admin/stats", () => HttpResponse.json(statsResponse())),
      http.get("/api/admin/users", () => HttpResponse.json(usersResponse())),
      http.get("/api/admin/plan-defaults", () => HttpResponse.json(planDefaultsResponse())),
    );

    renderWithProviders(<AdminUsersPage />);

    expect(await screen.findByText("user-1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // totalUsers
    expect(screen.getByLabelText("FREE / ANALYSES_DAILY")).toHaveValue("15");
  });

  it("filters the user table to only those at/over any limit", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/stats", () => HttpResponse.json(statsResponse())),
      http.get("/api/admin/users", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(usersResponse());
      }),
      http.get("/api/admin/plan-defaults", () => HttpResponse.json(planDefaultsResponse())),
    );

    renderWithProviders(<AdminUsersPage />);

    await screen.findByText("user-1");
    await userEvent.click(screen.getByRole("checkbox", { name: "At/over any limit" }));

    expect(await screen.findByText("user-1")).toBeInTheDocument();
    expect(capturedUrl).toContain("atOrOverLimit=true");
  });

  it("saves an edited plan-default limit", async () => {
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/stats", () => HttpResponse.json(statsResponse())),
      http.get("/api/admin/users", () => HttpResponse.json(usersResponse())),
      http.get("/api/admin/plan-defaults", () => HttpResponse.json(planDefaultsResponse())),
      http.put("/api/admin/plan-defaults/FREE/ANALYSES_DAILY", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ plan: "FREE", quotaKind: "ANALYSES_DAILY", limit: 25 });
      }),
    );

    renderWithProviders(<AdminUsersPage />);

    const input = await screen.findByLabelText("FREE / ANALYSES_DAILY");
    await userEvent.clear(input);
    await userEvent.type(input, "25");
    await userEvent.click(screen.getByRole("button", { name: "Save FREE / ANALYSES_DAILY" }));

    expect(capturedBody).toEqual({ limit: 25 });
  });
});
