import { expect, test } from "@playwright/test";
import { stubApi } from "./network-stub";

test("serves the marketing landing page in a real browser", async ({ page }) => {
  await stubApi(page);
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  // Hero headline and the repeated primary call to action.
  await expect(page.locator("h1")).toBeVisible();
  const signInLinks = page.getByRole("link", { name: "Sign in" });
  await expect(signInLinks.first()).toHaveAttribute("href", "/sign-in");
  expect(await signInLinks.count()).toBeGreaterThanOrEqual(2);

  // Marketing sections are present.
  await expect(
    page.getByRole("heading", { name: "How it works" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Frequently asked questions" }),
  ).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
});
