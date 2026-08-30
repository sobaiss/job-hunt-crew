import type { Page, Route } from "@playwright/test";

type StubResponse = {
  status?: number;
  json?: unknown;
};

// The single Playwright network stub. Every request under `/api/**` (BFF routes
// and `/api/auth/*`) is fulfilled from here so browser tests never depend on a
// running backend. Pass `routes` to override specific endpoints by URL substring;
// anything unmatched gets `200 {}`.
export async function stubApi(
  page: Page,
  routes: Record<string, StubResponse> = {},
): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const url = route.request().url();
    const match = Object.entries(routes).find(([key]) => url.includes(key));
    const { status = 200, json = {} } = match ? match[1] : {};
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });
}
