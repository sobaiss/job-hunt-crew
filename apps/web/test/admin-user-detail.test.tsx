import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import AdminUserDetailPage from "@/app/(app)/admin/users/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "user-1" }),
}));

function quotasResponse(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    plan: "FREE",
    quotas: {
      ACTIVE_SCOUTS: { cap: 2, used: 1, remaining: 1, hasOverride: false },
      ANALYSES_DAILY: { cap: 15, used: 3, remaining: 12, hasOverride: false },
      ANALYSES_MONTHLY: { cap: 300, used: 3, remaining: 297, hasOverride: false },
      DOCUMENTS_DAILY: { cap: 5, used: 0, remaining: 5, hasOverride: false },
    },
    ...overrides,
  };
}

describe("AdminUserDetailPage", () => {
  it("renders the target User's Plan and per-QuotaKind usage", async () => {
    server.use(
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
    );

    renderWithProviders(<AdminUserDetailPage />);

    expect(await screen.findByText("User user-1")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Plan" })).toHaveValue("FREE");
    expect(screen.getByText("1 of 2 (1 remaining)")).toBeInTheDocument();
    expect(screen.getByText("3 of 15 (12 remaining)")).toBeInTheDocument();
  });

  it("flags a QuotaKind carrying an explicit override and lets it be cleared", async () => {
    server.use(
      http.get("/api/admin/users/user-1/quotas", () =>
        HttpResponse.json(
          quotasResponse({
            quotas: {
              ...quotasResponse().quotas,
              ANALYSES_DAILY: { cap: 50, used: 3, remaining: 47, hasOverride: true },
            },
          }),
        ),
      ),
      http.delete("/api/admin/users/user-1/quota-overrides/ANALYSES_DAILY", () =>
        HttpResponse.json(null, { status: 204 }),
      ),
    );

    renderWithProviders(<AdminUserDetailPage />);

    expect(await screen.findByText(/override active/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear override" }));
  });

  it("sets a numeric override via the input + Set override button", async () => {
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/quota-overrides/ANALYSES_DAILY", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ quotaKind: "ANALYSES_DAILY", limit: 99 });
      }),
    );

    renderWithProviders(<AdminUserDetailPage />);

    const input = await screen.findByLabelText("Override for ANALYSES_DAILY");
    await userEvent.clear(input);
    await userEvent.type(input, "99");
    const row = input.closest("div");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Set override" }));

    expect(capturedBody).toEqual({ limit: 99 });
  });

  it("reassigns the User's Plan via the Plan select", async () => {
    let capturedBody: unknown;
    server.use(
      http.get("/api/admin/users/user-1/quotas", () => HttpResponse.json(quotasResponse())),
      http.put("/api/admin/users/user-1/plan", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ userId: "user-1", plan: "PREMIUM" });
      }),
    );

    renderWithProviders(<AdminUserDetailPage />);

    const select = await screen.findByRole("combobox", { name: "Plan" });
    await userEvent.selectOptions(select, "PREMIUM");

    expect(capturedBody).toEqual({ plan: "PREMIUM" });
  });

  it("shows an error state when the request fails", async () => {
    server.use(
      http.get("/api/admin/users/user-1/quotas", () =>
        HttpResponse.json({ error: "Forbidden" }, { status: 403 }),
      ),
    );

    renderWithProviders(<AdminUserDetailPage />);

    expect(
      await screen.findByText("Couldn't load this User's quotas."),
    ).toBeInTheDocument();
  });
});
