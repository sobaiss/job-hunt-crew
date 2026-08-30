import { expect, test } from "@playwright/test";
import { stubApi } from "./network-stub";

test("serves the root route in a real browser", async ({ page }) => {
  await stubApi(page);
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("h1")).toBeVisible();
});
