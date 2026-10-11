import { expect, test } from "@playwright/test";
import { stubApi } from "./network-stub";

test("serves the marketing landing page in a real browser", async ({ page }) => {
  await stubApi(page);
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  // Hero headline and the repeated primary call to action; "Sign in" is
  // kept only in the header.
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Your agents find the offers. You choose where to apply.",
    }),
  ).toBeVisible();
  const startFree = page.getByRole("link", { name: "Start for free" });
  await expect(startFree.first()).toHaveAttribute("href", "/sign-in");
  expect(await startFree.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(1);

  // Marketing sections are present.
  await expect(
    page.getByRole("heading", {
      name: "From offer to application, all in one place",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Start for free, scale up when you need to",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Frequently asked questions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Let your agents search for you." }),
  ).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
});
