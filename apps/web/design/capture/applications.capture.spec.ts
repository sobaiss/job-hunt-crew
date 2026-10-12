import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

// Regenerates apps/web/public/applications-{light,dark}.png — the Application
// quick view opened from the Applications table, for the Landing page's
// #applications section (Landing v2, #251). Same recipe as
// agent-panel.capture.spec.ts: a locally-minted session and every `/api/*`
// call faked with demo data. The offers are the hero card's (Payflow 91,
// Kessel 84, Novable 76); the Quick view is opened on Payflow, which is
// in progress with both documents generated and a dated history. Only the
// panel is captured: the page behind it says "Scout" in its subtitle, which
// the Landing page never shows (spec landing-v2).
// Not run by `pnpm test:e2e`; invoke explicitly (see playwright.capture.config.ts).

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(WEB_ROOT, "public");
const ORIGIN = "http://localhost:3000";

function authSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const env = fs.readFileSync(path.join(WEB_ROOT, ".env"), "utf8");
  const match = env.match(/^\s*AUTH_SECRET\s*=\s*"?([^"\n]+?)"?\s*$/m);
  if (!match) throw new Error("AUTH_SECRET not found in apps/web/.env");
  return match[1];
}

const CV_ID = "cv-data";
const PAYFLOW_ID = "app-payflow";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

type Status = "DRAFT" | "APPLIED" | "INTERVIEWING";

function application(
  id: string,
  title: string,
  company: string,
  matchScore: number,
  sourceSite: string,
  status: Status,
  appliedDaysAgo: number | null,
  withDocuments: boolean,
): Record<string, unknown> {
  return {
    id,
    userId: "user-preview",
    analysisId: `analysis-${id}`,
    jobOfferId: `offer-${id}`,
    cvVersionId: CV_ID,
    // Left null: a non-null scoutId adds a "View the Scout" button, and the
    // Landing page never shows that word (spec landing-v2).
    scoutId: null,
    coverLetterDocId: withDocuments ? `letter-${id}` : null,
    tailoredCvDocId: withDocuments ? `cv-${id}` : null,
    status,
    appliedAt: appliedDaysAgo === null ? null : daysAgo(appliedDaysAgo),
    createdAt: daysAgo(9),
    updatedAt: daysAgo(1),
    jobOffer: {
      id: `offer-${id}`,
      title,
      company,
      location: "Paris",
      sourceSite,
      sourceUrl: "https://example.com/offer",
    },
    cvVersion: { label: "CV Data Engineer" },
    matchScore,
    tailoredCvStatus: withDocuments ? "READY" : null,
    coverLetterStatus: withDocuments ? "READY" : null,
  };
}

const PAYFLOW = application(
  PAYFLOW_ID,
  "Senior Data Engineer",
  "Payflow",
  91,
  "WTTJ",
  "INTERVIEWING",
  8,
  true,
);

const APPLICATIONS = {
  applications: [
    PAYFLOW,
    application("app-kessel", "Data Engineer Spark", "Kessel", 84, "FRANCE_TRAVAIL", "APPLIED", 3, true),
    application("app-novable", "Analytics Engineer", "Novable", 76, "HELLOWORK", "DRAFT", null, false),
  ],
};

function statusEvent(id: string, status: Status, days: number, note: string | null) {
  return {
    id,
    applicationId: PAYFLOW_ID,
    status,
    note,
    effectiveDate: daysAgo(days),
    createdAt: daysAgo(days),
  };
}

const PAYFLOW_DETAIL = {
  application: {
    ...PAYFLOW,
    statusEvents: [
      statusEvent("ev1", "DRAFT", 9, null),
      statusEvent("ev2", "APPLIED", 8, "Sent the tailored CV and cover letter on their careers page."),
      statusEvent(
        "ev3",
        "INTERVIEWING",
        2,
        "Call with the data platform lead on Thursday: Spark at scale and the payments domain.",
      ),
    ],
  },
};

const PAYFLOW_ANALYSIS = {
  analysis: {
    id: `analysis-${PAYFLOW_ID}`,
    status: "COMPLETED",
    matchScore: 91,
    resultJSON: {
      match_score: 91,
      matched_skills: [],
      missing_skills: [],
      strengths: [],
      weaknesses: [],
      improvement_suggestions: [],
      summary: "A strong fit: payments data, Spark and Airflow at scale.",
    },
    errorMessage: null,
  },
};

const THEMES = ["light", "dark"] as const;

test("regenerate the Landing-page applications screenshots", async ({ browser }) => {
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
      viewport: { width: 1440, height: 760 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await context.addCookies([
      { name: "authjs.session-token", value: token, url: ORIGIN },
      { name: "NEXT_LOCALE", value: "en", url: ORIGIN },
    ]);

    const page = await context.newPage();
    await page.addInitScript((value) => {
      window.localStorage.setItem("theme", value);
    }, theme);

    const json = (body: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    // Catch-all first so the specific handlers registered after it win.
    await page.route("**/api/**", (route) => route.fulfill(json({})));
    await page.route("**/api/applications", (route) => route.fulfill(json(APPLICATIONS)));
    await page.route(`**/api/applications/${PAYFLOW_ID}`, (route) =>
      route.fulfill(json(PAYFLOW_DETAIL)),
    );
    await page.route(`**/api/analyses/analysis-${PAYFLOW_ID}`, (route) =>
      route.fulfill(json(PAYFLOW_ANALYSIS)),
    );
    await page.route("**/api/scouts**", (route) => route.fulfill(json({ scouts: [] })));

    await page.goto("/applications");
    await page.getByRole("row").filter({ hasText: "Payflow" }).click();
    const panel = page.locator("[data-slot='sheet-content']");
    await expect(panel.getByText("Call with the data platform lead")).toBeVisible();
    await expect(panel.getByText("A strong fit")).toBeVisible();
    // Let the slide-in animation settle.
    await page.waitForTimeout(1000);

    await panel.screenshot({
      path: path.join(PUBLIC_DIR, `applications-${theme}.png`),
    });

    await context.close();
  }
});
