import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

// Regenerates apps/web/public/agent-panel-{light,dark}.png — the real Agent
// panel the Landing page's #agents section shows (Landing v2, #248). Same
// recipe as the other capture scenarios: a locally-minted session and every
// `/api/*` call faked with demo data. The demo agent is the hero card's
// ("Data Engineer — Paris": Payflow 91, Kessel 84, Novable 76, a run this
// morning with 31 offers analysed and 4 relevant).
// Not run by `pnpm test:e2e`; invoke explicitly (see playwright.capture.config.ts).

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(WEB_ROOT, "public");
const ORIGIN = "http://localhost:3000";

function authSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const env = fs.readFileSync(path.join(WEB_ROOT, "..", "..", ".env"), "utf8");
  const match = env.match(/^\s*AUTH_SECRET\s*=\s*"?([^"\n]+?)"?\s*$/m);
  if (!match) throw new Error("AUTH_SECRET not found in the root .env");
  return match[1];
}

const SCOUT_ID = "scout-data-engineer";
const CV_ID = "cv-data";

/** A time `hours` before now: relative to the capture's own clock, so the
 *  latest run is always over an hour old and "Run now" shows rather than its
 *  cooldown, whatever time of day the capture runs. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function daysAgo(days: number): string {
  return hoursAgo(3 + days * 24);
}

const SCOUT = {
  id: SCOUT_ID,
  userId: "user-preview",
  label: "Data Engineer — Paris",
  cvVersionId: CV_ID,
  targetSiteKeys: ["FRANCE_TRAVAIL", "WTTJ", "HELLOWORK"],
  filters: {
    keywords: "Data Engineer",
    location: "Paris",
    postedWithin: "7d",
    contractType: ["CDI"],
    remote: "hybrid",
    experienceLevel: null,
  },
  matchThreshold: 70,
  status: "ACTIVE",
  lastRunAt: hoursAgo(2.9),
  createdAt: daysAgo(21),
  updatedAt: daysAgo(21),
  relevantFindsCount: 4,
  runState: "OK",
  runStateSince: null,
  blockedAnalysisIds: [],
};

function find(
  id: string,
  title: string,
  company: string,
  matchScore: number,
  sourceSite: string,
): Record<string, unknown> {
  return {
    id,
    status: "COMPLETED",
    matchScore,
    requestedAt: hoursAgo(2.95),
    requeuedAt: null,
    stuck: false,
    cvVersionId: CV_ID,
    ingestionJobId: "job-morning",
    // Left null: a non-null scoutId adds the row's "Scout" tag, and the
    // Landing page never shows that word (spec landing-v2).
    scoutId: null,
    applicationStatus: null,
    tailoredCvStatus: null,
    coverLetterStatus: null,
    jobOffer: {
      id: `offer-${id}`,
      title,
      company,
      location: "Paris",
      sourceSite,
      postedAt: daysAgo(1),
      sourceUrl: "https://example.com/offer",
    },
    cvVersion: { label: "CV Data Engineer" },
    ingestionJob: { mode: "SITE_SEARCH", siteConfigId: "site-wttj" },
    resultJSON: null,
    errorMessage: null,
  };
}

const FINDS = {
  relevantFinds: [
    find("f1", "Senior Data Engineer", "Payflow", 91, "WTTJ"),
    find("f2", "Data Engineer Spark", "Kessel", 84, "FRANCE_TRAVAIL"),
    find("f3", "Analytics Engineer", "Novable", 76, "HELLOWORK"),
    find("f4", "Data Platform Engineer", "Ordalie", 72, "WTTJ"),
  ],
  lowFitFinds: [],
};

function run(
  id: string,
  createdAt: string,
  counts: { discovered: number; analysed: number; relevant: number; seen: number },
): Record<string, unknown> {
  const finished = new Date(new Date(createdAt).getTime() + 6 * 60_000);
  return {
    id,
    scoutId: SCOUT_ID,
    status: "COMPLETED",
    sitesQueried: 3,
    siteUnavailableCount: 0,
    offersDiscovered: counts.discovered,
    offersAnalysed: counts.analysed,
    relevantCount: counts.relevant,
    failedCount: 0,
    alreadySeenCount: counts.seen,
    runLimitSkippedCount: 0,
    capSkippedCount: 0,
    errorMessage: null,
    startedAt: createdAt,
    finishedAt: finished.toISOString(),
    createdAt,
  };
}

// Newest first, the way `/api/scouts/:id/runs` returns them.
const RUNS = {
  scoutRuns: [
    run("r3", hoursAgo(3), { discovered: 44, analysed: 31, relevant: 4, seen: 13 }),
    run("r2", daysAgo(1), { discovered: 38, analysed: 22, relevant: 2, seen: 16 }),
    run("r1", daysAgo(2), { discovered: 41, analysed: 27, relevant: 3, seen: 14 }),
  ],
};

function statsWindow(
  over: Partial<Record<string, number | null>>,
): Record<string, number | null> {
  return {
    offersDiscovered: 0,
    relevantFinds: 0,
    documentsGenerated: 0,
    applicationsSubmitted: 0,
    responseRate: 0,
    interviewRate: 0,
    offerRate: 0,
    acceptanceRate: 0,
    medianDaysToFirstResponse: null,
    ...over,
  };
}

const STATS = {
  allTime: statsWindow({
    offersDiscovered: 412,
    relevantFinds: 38,
    documentsGenerated: 14,
    applicationsSubmitted: 9,
    responseRate: 44,
    interviewRate: 33,
    offerRate: 11,
    acceptanceRate: 0,
    medianDaysToFirstResponse: 6,
  }),
  last30Days: statsWindow({
    offersDiscovered: 412,
    relevantFinds: 38,
    documentsGenerated: 14,
    applicationsSubmitted: 9,
    responseRate: 44,
    interviewRate: 33,
    offerRate: 11,
    acceptanceRate: 0,
    medianDaysToFirstResponse: 6,
  }),
};

// The panel's FilterSupport notice reads these: HelloWork approximates
// remote work, France Travail does not take it at all.
const SITE_CONFIGS = {
  siteConfigs: [
    {
      id: "site-ft",
      siteKey: "FRANCE_TRAVAIL",
      displayName: "France Travail",
      integrationType: "OFFICIAL_API",
      antiBotRiskLevel: "LOW",
      filterSupport: {
        keywords: { level: "SUPPORTED", reason: "" },
        location: { level: "SUPPORTED", reason: "" },
        postedWithin: { level: "SUPPORTED", reason: "" },
        contractType: { level: "SUPPORTED", reason: "" },
        remote: { level: "UNSUPPORTED", reason: "" },
      },
    },
    {
      id: "site-wttj",
      siteKey: "WTTJ",
      displayName: "Welcome to the Jungle",
      integrationType: "SCRAPING",
      antiBotRiskLevel: "LOW",
      filterSupport: {
        keywords: { level: "SUPPORTED", reason: "" },
        location: { level: "SUPPORTED", reason: "" },
        postedWithin: { level: "SUPPORTED", reason: "" },
        contractType: { level: "SUPPORTED", reason: "" },
        remote: { level: "SUPPORTED", reason: "" },
      },
    },
    {
      id: "site-hw",
      siteKey: "HELLOWORK",
      displayName: "HelloWork",
      integrationType: "SCRAPING",
      antiBotRiskLevel: "LOW",
      filterSupport: {
        keywords: { level: "SUPPORTED", reason: "" },
        location: { level: "SUPPORTED", reason: "" },
        postedWithin: { level: "SUPPORTED", reason: "" },
        contractType: { level: "SUPPORTED", reason: "" },
        remote: { level: "APPROXIMATED", reason: "" },
      },
    },
  ],
};

const CV_VERSIONS = { cvVersions: [{ id: CV_ID, label: "CV Data Engineer" }] };

const THEMES = ["light", "dark"] as const;

test("regenerate the Landing-page Agent panel screenshots", async ({ browser }) => {
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
    await page.route("**/api/scouts", (route) => route.fulfill(json({ scouts: [SCOUT] })));
    await page.route(`**/api/scouts/${SCOUT_ID}`, (route) =>
      route.fulfill(json({ scout: SCOUT })),
    );
    await page.route(`**/api/scouts/${SCOUT_ID}/runs`, (route) =>
      route.fulfill(json(RUNS)),
    );
    await page.route(`**/api/scouts/${SCOUT_ID}/finds`, (route) =>
      route.fulfill(json(FINDS)),
    );
    await page.route(`**/api/scouts/${SCOUT_ID}/stats`, (route) =>
      route.fulfill(json(STATS)),
    );
    await page.route("**/api/site-configs**", (route) => route.fulfill(json(SITE_CONFIGS)));
    await page.route("**/api/cv-versions**", (route) => route.fulfill(json(CV_VERSIONS)));

    await page.goto(`/scouts?open=${SCOUT_ID}`);
    const panel = page.locator("[data-slot='sheet-content']");
    await expect(panel.getByText("Data Engineer — Paris").first()).toBeVisible();
    await expect(panel.getByText("Payflow")).toBeVisible();
    await expect(panel.getByText("HelloWork").first()).toBeVisible();
    // Let the slide-in animation and the async sections settle.
    await page.waitForTimeout(1000);

    await panel.screenshot({
      path: path.join(PUBLIC_DIR, `agent-panel-${theme}.png`),
    });

    await context.close();
  }
});
