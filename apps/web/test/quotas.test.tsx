import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import QuotasPage from "@/app/(app)/quotas/page";

describe("QuotasPage", () => {
  it("renders all four QuotaKinds as progress bars from a mocked GET /api/quotas response", async () => {
    server.use(
      http.get("/api/quotas", () =>
        HttpResponse.json({
          activeScouts: { cap: 5, used: 2, remaining: 3 },
          analysesDaily: { cap: 50, used: 45, remaining: 5 },
          analysesMonthly: { cap: 1000, used: 300, remaining: 700 },
          documentsDaily: { cap: 20, used: 0, remaining: 20 },
        }),
      ),
    );

    renderWithProviders(<QuotasPage />);

    expect(await screen.findByText("Active Scouts")).toBeInTheDocument();
    expect(screen.getByText("2 of 5")).toBeInTheDocument();

    expect(screen.getByText("Analyses today")).toBeInTheDocument();
    expect(screen.getByText("45 of 50")).toBeInTheDocument();

    expect(screen.getByText("Analyses this month")).toBeInTheDocument();
    expect(screen.getByText("300 of 1000")).toBeInTheDocument();

    expect(screen.getByText("Documents today")).toBeInTheDocument();
    expect(screen.getByText("0 of 20")).toBeInTheDocument();

    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
  });

  it("shows an unlimited indicator instead of a cap for a QuotaKind with no ceiling", async () => {
    server.use(
      http.get("/api/quotas", () =>
        HttpResponse.json({
          activeScouts: { cap: null, used: 7, remaining: null },
          analysesDaily: { cap: 50, used: 0, remaining: 50 },
          analysesMonthly: { cap: 1000, used: 0, remaining: 1000 },
          documentsDaily: { cap: 20, used: 0, remaining: 20 },
        }),
      ),
    );

    renderWithProviders(<QuotasPage />);

    expect(await screen.findByText("7 used — unlimited")).toBeInTheDocument();
  });

  it("shows an error state when the quotas request fails", async () => {
    server.use(
      http.get("/api/quotas", () => HttpResponse.json({ error: "Boom" }, { status: 500 })),
    );

    renderWithProviders(<QuotasPage />);

    expect(
      await screen.findByText("We couldn't load your quotas. Please try again."),
    ).toBeInTheDocument();
  });
});
