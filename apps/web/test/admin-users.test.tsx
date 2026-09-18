import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { Session } from "next-auth";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminUsersPage from "@/app/(app)/admin/users/page";

const ADMIN_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "admin-1", name: "Admin", email: "admin@example.com", isAdmin: true },
};

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

function quotasResponse(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    name: "Ada Lovelace",
    email: "user1@example.com",
    plan: "FREE",
    planEndDate: null,
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
  server.use(http.get("/api/admin/stats", () => HttpResponse.json(statsResponse())));
}

describe("AdminUsersPage", () => {
  beforeEach(() => {
    __setUrl("/admin/users");
  });

  afterEach(() => {
    __setUrl("/admin/users");
  });

  it("renders the users table", async () => {
    mockCommon();
    server.use(http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())));

    renderWithProviders(<AdminUsersPage />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
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

  it("shows the audit history tab with resolved actor info", async () => {
    mockCommon();
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.get("/api/admin/users/user-1/audit-events", () =>
        HttpResponse.json({
          events: [
            {
              id: "event-1",
              field: "blockedAt",
              oldValue: "null",
              newValue: "2026-01-02T00:00:00.000Z",
              createdAt: "2026-01-02T00:00:00.000Z",
              actor: { id: "admin-1", name: "Admin", email: "admin@example.com" },
            },
          ],
        }),
      ),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));
    await userEvent.click(await screen.findByRole("tab", { name: "Audit history" }));

    expect(await screen.findByText("blockedAt")).toBeInTheDocument();
    expect(screen.getByText(/^by Admin on/)).toBeInTheDocument();
  });

  it("shows an empty state in the audit history tab when no events exist", async () => {
    mockCommon();
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.get("/api/admin/users/user-1/audit-events", () =>
        HttpResponse.json({ events: [] }),
      ),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));
    await userEvent.click(await screen.findByRole("tab", { name: "Audit history" }));

    expect(
      await screen.findByText("No admin actions recorded for this User yet."),
    ).toBeInTheDocument();
  });

  it("reassigns the User's Plan to Free from the panel with no duration", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/plan", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", plan: "FREE", endDate: null });
      }),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    await userEvent.click(await screen.findByRole("button", { name: "Assign" }));

    expect(capturedBody).toEqual({ plan: "FREE", duration: null });
  });

  it("requires a duration before assigning Standard/Premium from the panel", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/plan", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", plan: "PREMIUM", endDate: "2026-02-01T00:00:00.000Z" });
      }),
    );

    renderWithProviders(<AdminUsersPage />);
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const planSelect = await screen.findByRole("combobox", { name: "Plan" });
    await userEvent.selectOptions(planSelect, "PREMIUM");

    const assignButton = screen.getByRole("button", { name: "Assign" });
    expect(assignButton).toBeDisabled();

    const durationSelect = screen.getByRole("combobox", { name: "Duration" });
    await userEvent.selectOptions(durationSelect, "YEARLY");
    expect(assignButton).toBeEnabled();

    await userEvent.click(assignButton);

    expect(capturedBody).toEqual({ plan: "PREMIUM", duration: "YEARLY" });
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

    const input = await screen.findByLabelText("Override for Analyses today");
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

  it("blocks a User from the table row after inline confirmation", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.put("/api/admin/users/user-1/blocked", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", blocked: true });
      }),
    );

    renderWithProviders(<AdminUsersPage />, { session: ADMIN_SESSION });
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Block" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(capturedBody).toEqual({ blocked: true });
  });

  it("disables the block action for the Administrator's own row", async () => {
    mockCommon();
    server.use(
      http.get("/api/admin/users", () =>
        HttpResponse.json(usersListResponse({ users: [{ ...usersListResponse().users[0], id: "admin-1" }] })),
      ),
    );

    renderWithProviders(<AdminUsersPage />, { session: ADMIN_SESSION });
    await screen.findByText("Ada Lovelace");

    expect(screen.getByRole("button", { name: "Block" })).toBeDisabled();
  });

  it("blocks a User from the User panel after inline confirmation", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/blocked", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", blocked: true });
      }),
    );

    renderWithProviders(<AdminUsersPage />, { session: ADMIN_SESSION });
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const panel = (await screen.findByText("User user-1")).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: "Block" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Confirm" }));

    expect(capturedBody).toEqual({ blocked: true });
  });

  it("edits a User's name from the panel", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/info", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", name: "Grace Hopper" });
      }),
    );

    renderWithProviders(<AdminUsersPage />, { session: ADMIN_SESSION });
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const panel = (await screen.findByText("User user-1")).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: "Edit" }));

    const input = within(panel).getByLabelText("Name");
    await userEvent.clear(input);
    await userEvent.type(input, "Grace Hopper");
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ name: "Grace Hopper" });
  });

  it("grants the admin role from the panel after inline confirmation", async () => {
    mockCommon();
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse())),
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/admin-role", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", isAdmin: true });
      }),
    );

    renderWithProviders(<AdminUsersPage />, { session: ADMIN_SESSION });
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const panel = (await screen.findByText("User user-1")).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: "Grant admin" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Confirm" }));

    expect(capturedBody).toEqual({ isAdmin: true });
  });

  it("disables the admin-role action for the Administrator's own row in the panel", async () => {
    mockCommon();
    server.use(
      http.get("/api/admin/users", () =>
        HttpResponse.json(usersListResponse({ users: [{ ...usersListResponse().users[0], id: "admin-1" }] })),
      ),
      http.get("/api/admin/users/admin-1/quotas", () =>
        HttpResponse.json(quotasResponse({ userId: "admin-1", isAdmin: true })),
      ),
    );

    renderWithProviders(<AdminUsersPage />, { session: ADMIN_SESSION });
    await userEvent.click(await screen.findByText("Ada Lovelace"));

    const panel = (await screen.findByText("User admin-1")).closest('[role="dialog"]') as HTMLElement;
    expect(within(panel).getByRole("button", { name: "Revoke admin" })).toBeDisabled();
  });
});
