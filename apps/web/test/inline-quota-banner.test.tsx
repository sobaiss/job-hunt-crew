import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { server } from "./msw/server";
import { InlineQuotaBanner } from "@/components/inline-quota-banner";

function quotasResponse(overrides: Record<string, { cap: number | null; used: number; remaining: number | null }>) {
  return {
    activeScouts: { cap: 20, used: 0, remaining: 20 },
    analysesDaily: { cap: 20, used: 0, remaining: 20 },
    analysesMonthly: { cap: 200, used: 0, remaining: 200 },
    documentsDaily: { cap: 20, used: 0, remaining: 20 },
    alerts: [],
    ...overrides,
  };
}

describe("InlineQuotaBanner", () => {
  it("renders nothing when the given QuotaKind still has remaining headroom", async () => {
    let loaded = false;
    server.use(
      http.get("/api/quotas", () => {
        loaded = true;
        return HttpResponse.json(quotasResponse({}));
      }),
    );

    renderWithProviders(<InlineQuotaBanner kinds={["activeScouts"]} />);

    await waitFor(() => expect(loaded).toBe(true));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a blocked banner naming the QuotaKind once its remaining hits zero", async () => {
    server.use(
      http.get("/api/quotas", () =>
        HttpResponse.json(
          quotasResponse({ activeScouts: { cap: 2, used: 2, remaining: 0 } }),
        ),
      ),
    );

    renderWithProviders(<InlineQuotaBanner kinds={["activeScouts"]} />);

    expect(
      await screen.findByText(
        "You've reached your Active Scouts limit. Try again once it resets, or check your Quotas page.",
      ),
    ).toBeInTheDocument();
  });

  it("checks every kind given it and shows the banner for whichever one is blocked", async () => {
    server.use(
      http.get("/api/quotas", () =>
        HttpResponse.json(
          quotasResponse({ analysesMonthly: { cap: 30, used: 30, remaining: 0 } }),
        ),
      ),
    );

    renderWithProviders(<InlineQuotaBanner kinds={["analysesDaily", "analysesMonthly"]} />);

    expect(
      await screen.findByText(
        "You've reached your Analyses this month limit. Try again once it resets, or check your Quotas page.",
      ),
    ).toBeInTheDocument();
  });
});
