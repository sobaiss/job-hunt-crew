import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminUsersPage from "@/app/(app)/admin/users/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return mock;
});

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

function usersListResponse(overrides: Record<string, unknown> = {}) {
  return {
    users: [
      {
        id: "user-1",
        name: "Ada Lovelace",
        email: "user1@example.com",
        plan: "FREE",
        isAdmin: false,
        blocked: false,
        atOrOverLimit: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
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

function quotasResponse(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    name: "Ada Lovelace",
    email: "user1@example.com",
    plan: "FREE",
    isAdmin: false,
    blocked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    quotas: {
      ACTIVE_SCOUTS: { cap: 2, used: 1, remaining: 1, hasOverride: false },
      ANALYSES_DAILY: { cap: 15, used: 3, remaining: 12, hasOverride: false },
      ANALYSES_MONTHLY: { cap: 300, used: 3, remaining: 297, hasOverride: false },
      DOCUMENTS_DAILY: { cap: 5, used: 0, remaining: 5, hasOverride: false },
    },
    ...overrides,
  };
}

function mockCommon() {
  server.use(
    http.get("/api/admin/stats", () => HttpResponse.json(statsResponse())),
    http.get("/api/admin/plan-defaults", () => HttpResponse.json(planDefaultsResponse())),
  );
}

describe("AdminUsersPage", () => {
  beforeEach(() => {
    __setUrl("/admin/users");
  });

  afterEach(() => {
    __setUrl("/admin/users");
  });

  it("renders global stats, the plan-defaults editor, and the users table", async () => {
    mockCommon();
    server.use(http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())));

    renderWithProviders(<AdminUsersPage />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // totalUsers
    expect(screen.getByLabelText("FREE / ANALYSES_DAILY")).toHaveValue("15");
  });

  it("sends the search term and filters as server-side query params", async () => {
    mockCommon();
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/users", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(usersListResponse());
      }),
    );

    renderWithProviders(<AdminUsersPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.type(screen.getByLabelText("Search"), "ada");
    await userEvent.click(screen.getByLabelText("At/over any limit"));

    expect(capturedUrl).toContain("search=ada");
    expect(capturedUrl).toContain("atOrOverLimit=true");
  });

  it("toggles sort direction when a sortable column header is clicked", async () => {
    mockCommon();
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/users", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(usersListResponse());
      }),
    );

    renderWithProviders(<AdminUsersPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(capturedUrl).toContain("sortBy=name");
    expect(capturedUrl).toContain("sortDir=asc");
  });

  it("opens the User panel with info, Plan, and quotas when a row is clicked", async () => {
    mockCommon();
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    expect(await screen.findByText("User user-1")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Plan" })).toHaveValue("FREE");
    expect(screen.getByText("3 of 15 (12 remaining)")).toBeInTheDocument();
  });

  it("reassigns the User's Plan from the panel", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/plan", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", plan: "PREMIUM" });
      }),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const select = await screen.findByRole("combobox", { name: "Plan" });
    await userEvent.selectOptions(select, "PREMIUM");

    expect(capturedBody).toEqual({ plan: "PREMIUM" });
  });

  it("sets a quota override from the panel", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/quota-overrides/ANALYSES_DAILY", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ quotaKind: "ANALYSES_DAILY", limit: 99 });
      }),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const input = await screen.findByLabelText("Override for ANALYSES_DAILY");
    await userEvent.clear(input);
    await userEvent.type(input, "99");
    const row = input.closest("div") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Set override" }));

    expect(capturedBody).toEqual({ limit: 99 });
  });

  it("shows an empty state when no Users match the filters", async () => {
    mockCommon();
    server.use(
      http.get("/api/admin/users", () =>
        HttpResponse.json(usersListResponse({ users: [], total: 0 })),
      ),
    );

    renderWithProviders(<AdminUsersPage />);

    expect(await screen.findByText("No Users yet.")).toBeInTheDocument();
  });

  it("saves an edited plan-default limit", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
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
