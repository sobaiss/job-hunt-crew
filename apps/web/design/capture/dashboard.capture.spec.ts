import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

// Regenerates apps/web/public/dashboard-preview-{light,dark}.png — the real
// Dashboard screenshots the Landing page embeds. Not run by `pnpm test:e2e`;
// invoke explicitly (see playwright.capture.config.ts).

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(WEB_ROOT, "public");
const ORIGIN = "http://localhost:3000";

/** The dev server reads `.env`; this Node process needs the same secret to
 *  mint a cookie `auth()` will accept. */
function authSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const env = fs.readFileSync(path.join(WEB_ROOT, ".env"), "utf8");
  const match = env.match(/^\s*AUTH_SECRET\s*=\s*"?([^"\n]+?)"?\s*$/m);
  if (!match) throw new Error("AUTH_SECRET not found in apps/web/.env");
  return match[1];
}

function analysis(
  over: Partial<Record<string, unknown>> & { id: string },
): Record<string, unknown> {
  return {
    status: "COMPLETED",
    matchScore: null,
    requestedAt: "2026-08-01T09:00:00.000Z",
    cvVersionId: "cv-senior",
    ingestionJobId: null,
    ingestionJob: null,
    jobOffer: { id: `job-${over.id}`, title: "Role", company: "Company" },
    cvVersion: { label: "Senior CV" },
    resultJSON: null,
    errorMessage: null,
    ...over,
  };
}

// Recency-ordered (newest first), the way `/api/analyses` returns it.
const ANALYSES = {
  analyses: [
    analysis({
      id: "a7",
      status: "RUNNING_CREW",
      matchScore: null,
      requestedAt: "2026-09-06T14:20:00.000Z",
      jobOffer: { id: "job-a7", title: "Staff Frontend Engineer", company: "Lumen Labs" },
    }),
    analysis({
      id: "a6",
      matchScore: 82,
      requestedAt: "2026-09-04T10:05:00.000Z",
      jobOffer: { id: "job-a6", title: "Senior React Engineer", company: "Northwind" },
    }),
    analysis({
      id: "a5",
      matchScore: 77,
      requestedAt: "2026-08-30T16:40:00.000Z",
      jobOffer: { id: "job-a5", title: "Product Engineer", company: "Cobalt" },
    }),
    analysis({
      id: "a4",
      matchScore: 69,
      requestedAt: "2026-08-24T08:15:00.000Z",
      cvVersionId: "cv-grad",
      cvVersion: { label: "Grad CV" },
      jobOffer: { id: "job-a4", title: "Full-Stack Developer", company: "Meridian Health" },
    }),
    analysis({
      id: "a3",
      matchScore: 71,
      requestedAt: "2026-08-18T11:30:00.000Z",
      jobOffer: { id: "job-a3", title: "Frontend Engineer", company: "Aperture" },
    }),
    analysis({
      id: "a2",
      matchScore: 64,
      requestedAt: "2026-08-10T13:00:00.000Z",
      cvVersionId: "cv-grad",
      cvVersion: { label: "Grad CV" },
      jobOffer: { id: "job-a2", title: "Web Developer", company: "Bright Foundry" },
    }),
    analysis({
      id: "a1",
      matchScore: 58,
      requestedAt: "2026-08-02T09:00:00.000Z",
      cvVersionId: "cv-grad",
      cvVersion: { label: "Grad CV" },
      jobOffer: { id: "job-a1", title: "Junior Frontend Developer", company: "Kestrel" },
    }),
  ],
};

const CV_VERSIONS = {
  cvVersions: [
    { id: "cv-senior", label: "Senior CV" },
    { id: "cv-grad", label: "Grad CV" },
  ],
};

const THEMES = ["light", "dark"] as const;

test("regenerate the Landing-page Dashboard preview screenshots", async ({
  browser,
}) => {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  const token = await encode({
    salt: "authjs.session-token",
    secret: authSecret(),
    token: {
      name: "Maya Restrepo",
      email: "maya@example.com",
      sub: "user-preview",
      userId: "user-preview",
    },
  });

  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1400 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await context.addCookies([
      { name: "authjs.session-token", value: token, url: ORIGIN },
      { name: "NEXT_LOCALE", value: "en", url: ORIGIN },
    ]);

    const page = await context.newPage();
    // next-themes reads this before first paint.
    await page.addInitScript((value) => {
      window.localStorage.setItem("theme", value);
    }, theme);

    // Catch-all first so the specific handlers registered after it win.
    await page.route("**/api/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route("**/api/analyses**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ANALYSES),
      }),
    );
    await page.route("**/api/cv-versions**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CV_VERSIONS),
      }),
    );

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Overview" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Match score trend" }),
    ).toBeVisible();
    await expect(page.getByText("Recent analyses")).toBeVisible();
    // Let the recharts line settle (animation is off, but layout is async).
    await page.waitForTimeout(800);

    await page
      .getByRole("main")
      .screenshot({ path: path.join(PUBLIC_DIR, `dashboard-preview-${theme}.png`) });

    await context.close();
  }
});
