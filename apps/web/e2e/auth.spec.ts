import { expect, test } from "@playwright/test";
import { stubApi } from "./network-stub";

// Seam 2: middleware redirects, and reload persistence for theme and Locale —
// none of which jsdom can exercise. All `/api/*` traffic is faked.

test("an unauthenticated protected route redirects to sign-in carrying the return path", async ({
  page,
}) => {
  await stubApi(page);

  await page.goto("/analyses");

  await expect(page).toHaveURL("/sign-in?callbackUrl=%2Fanalyses");
  await expect(page.getByText("Sign in", { exact: true })).toBeVisible();
});

test("a session cookie lets the protected route through and stays there", async ({
  page,
  context,
}) => {
  await stubApi(page);
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: "stub-session-token",
      url: "http://localhost:3000",
    },
  ]);

  await page.goto("/analyses");

  await expect(page).toHaveURL("/analyses");
});

test("the theme choice survives a full reload with no flash of the wrong theme", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/sign-in");
  await page.evaluate(() => window.localStorage.setItem("theme", "dark"));

  await page.reload();

  // next-themes injects a render-blocking script, so the class is present the
  // moment the document is parsed — never toggled after paint.
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("the Locale choice survives a full reload", async ({ page, context }) => {
  await stubApi(page);
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "fr", url: "http://localhost:3000" },
  ]);

  await page.goto("/sign-in");

  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByText("Connexion", { exact: true })).toBeVisible();
});
