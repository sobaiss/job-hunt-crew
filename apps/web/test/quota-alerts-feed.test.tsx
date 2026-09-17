import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { server } from "./msw/server";
import { QuotaAlertsFeed } from "@/components/quota-alerts-feed";

describe("QuotaAlertsFeed", () => {
  it("shows nothing beyond an empty state when there are no unread QuotaAlerts", async () => {
    renderWithProviders(<QuotaAlertsFeed />);

    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(
      await screen.findByText("You're all caught up — no unread alerts."),
    ).toBeInTheDocument();
  });

  it("lists unread QuotaAlerts from the mocked GET /api/quotas response, persisted rather than a toast", async () => {
    server.use(
      http.get("/api/quotas", () =>
        HttpResponse.json({
          activeScouts: { cap: 5, used: 2, remaining: 3 },
          analysesDaily: { cap: 10, used: 8, remaining: 2 },
          analysesMonthly: { cap: 200, used: 0, remaining: 200 },
          documentsDaily: { cap: 20, used: 20, remaining: 0 },
          alerts: [
            {
              id: "alert-1",
              quotaKind: "ANALYSES_DAILY",
              threshold: "APPROACHING",
              createdAt: "2026-09-17T10:00:00.000Z",
            },
            {
              id: "alert-2",
              quotaKind: "DOCUMENTS_DAILY",
              threshold: "EXCEEDED",
              createdAt: "2026-09-17T11:00:00.000Z",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<QuotaAlertsFeed />);

    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));

    expect(
      await screen.findByText("You're approaching your Analyses today limit."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You've reached your Documents today limit."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 unread")).toBeInTheDocument();
  });

  it("dismissing an alert calls the mark-read endpoint and removes it from the feed", async () => {
    // The feed refetches GET /api/quotas after a successful dismiss, so the
    // handler's response reflects whether /read has been called yet.
    let dismissed = false;
    server.use(
      http.get("/api/quotas", () =>
        HttpResponse.json({
          activeScouts: { cap: 5, used: 2, remaining: 3 },
          analysesDaily: { cap: 10, used: 8, remaining: 2 },
          analysesMonthly: { cap: 200, used: 0, remaining: 200 },
          documentsDaily: { cap: 20, used: 0, remaining: 20 },
          alerts: dismissed
            ? []
            : [
                {
                  id: "alert-1",
                  quotaKind: "ANALYSES_DAILY",
                  threshold: "APPROACHING",
                  createdAt: "2026-09-17T10:00:00.000Z",
                },
              ],
        }),
      ),
      http.post("/api/quota-alerts/alert-1/read", () => {
        dismissed = true;
        return HttpResponse.json({
          id: "alert-1",
          quotaKind: "ANALYSES_DAILY",
          threshold: "APPROACHING",
          createdAt: "2026-09-17T10:00:00.000Z",
        });
      }),
    );

    renderWithProviders(<QuotaAlertsFeed />);

    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("Dismiss")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(
        screen.getByText("You're all caught up — no unread alerts."),
      ).toBeInTheDocument();
    });
  });
});
