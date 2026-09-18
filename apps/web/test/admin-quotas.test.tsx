import { afterEach, beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminQuotasPage from "@/app/(app)/admin/quotas/page";

function planDefaultsResponse() {
  return {
    defaults: [
      { plan: "FREE", quotaKind: "ACTIVE_SCOUTS", limit: 2 },
      { plan: "FREE", quotaKind: "ANALYSES_DAILY", limit: 15 },
      { plan: "FREE", quotaKind: "ANALYSES_MONTHLY", limit: 300 },
      { plan: "FREE", quotaKind: "DOCUMENTS_DAILY", limit: 5 },
      { plan: "STANDARD", quotaKind: "ACTIVE_SCOUTS", limit: 10 },
      { plan: "STANDARD", quotaKind: "ANALYSES_DAILY", limit: 50 },
      { plan: "STANDARD", quotaKind: "ANALYSES_MONTHLY", limit: 1000 },
      { plan: "STANDARD", quotaKind: "DOCUMENTS_DAILY", limit: 20 },
      { plan: "PREMIUM", quotaKind: "ACTIVE_SCOUTS", limit: null },
      { plan: "PREMIUM", quotaKind: "ANALYSES_DAILY", limit: null },
      { plan: "PREMIUM", quotaKind: "ANALYSES_MONTHLY", limit: null },
      { plan: "PREMIUM", quotaKind: "DOCUMENTS_DAILY", limit: null },
    ],
  };
}

describe("AdminQuotasPage", () => {
  beforeEach(() => {
    __setUrl("/admin/quotas");
    server.use(
      http.get("/api/admin/plan-defaults", () => HttpResponse.json(planDefaultsResponse())),
    );
  });

  afterEach(() => {
    __setUrl("/admin/quotas");
  });

  it("shows free/standard/premium's limits side by side, and never administrateur", async () => {
    renderWithProviders(<AdminQuotasPage />);

    expect(await screen.findByText("FREE")).toBeInTheDocument();
    expect(screen.getByText("STANDARD")).toBeInTheDocument();
    expect(screen.getByText("PREMIUM")).toBeInTheDocument();
    expect(screen.queryByText("ADMINISTRATEUR")).not.toBeInTheDocument();

    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getAllByText("Unlimited").length).toBe(4);
  });

  it("opens a slide-over with a Plan's four limits and saves only the changed ones", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("/api/admin/plan-defaults/STANDARD", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          defaults: [
            { plan: "STANDARD", quotaKind: "ACTIVE_SCOUTS", limit: 10 },
            { plan: "STANDARD", quotaKind: "ANALYSES_DAILY", limit: 99 },
            { plan: "STANDARD", quotaKind: "ANALYSES_MONTHLY", limit: 1000 },
            { plan: "STANDARD", quotaKind: "DOCUMENTS_DAILY", limit: 20 },
          ],
        });
      }),
    );

    renderWithProviders(<AdminQuotasPage />);
    await screen.findByText("STANDARD");

    // Columns are FREE, STANDARD, PREMIUM in that fixed order, so the
    // Modify buttons in the trailing Actions row follow the same order.
    await userEvent.click(screen.getAllByRole("button", { name: "Modify" })[1]);

    const sheet = (await screen.findByText("Edit STANDARD")).closest('[role="dialog"]') as HTMLElement;
    const analysesDailyInput = within(sheet).getByLabelText("Analyses today");
    await userEvent.clear(analysesDailyInput);
    await userEvent.type(analysesDailyInput, "99");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      limits: {
        ACTIVE_SCOUTS: 10,
        ANALYSES_DAILY: 99,
        ANALYSES_MONTHLY: 1000,
        DOCUMENTS_DAILY: 20,
      },
    });
  });

  it("submits an empty limit input as unlimited (null)", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("/api/admin/plan-defaults/FREE", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(planDefaultsResponse());
      }),
    );

    renderWithProviders(<AdminQuotasPage />);
    await screen.findByText("FREE");

    await userEvent.click(screen.getAllByRole("button", { name: "Modify" })[0]);

    const sheet = (await screen.findByText("Edit FREE")).closest('[role="dialog"]') as HTMLElement;
    const documentsDailyInput = within(sheet).getByLabelText("Documents today");
    await userEvent.clear(documentsDailyInput);
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    expect(
      (capturedBody as { limits: Record<string, unknown> }).limits.DOCUMENTS_DAILY,
    ).toBeNull();
  });
});
