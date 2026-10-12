import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

// Regenerates apps/web/public/tailored-cv-{light,dark}.png — the generated
// documents of an Analysis, as its Quick view shows them, for the Landing
// page's #documents section (Landing v2, #250). Same recipe as
// agent-panel.capture.spec.ts: a locally-minted session and every `/api/*`
// call faked with demo data. The offers are the hero card's (Payflow 91,
// Kessel 84, Novable 76); the Quick view is opened on Payflow, whose cover
// letter and TAILORED_CV are both READY.
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
const PAYFLOW_ID = "a1";
const COVER_LETTER_ID = "doc-letter";
const TAILORED_CV_ID = "doc-cv";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const PAYFLOW_RESULT = {
  match_score: 91,
  matched_skills: [
    { skill: "Spark", evidence: "Built Spark pipelines processing 2 TB of payment events a day." },
    { skill: "Airflow", evidence: "Orchestrated 60+ DAGs on Airflow." },
    { skill: "dbt", evidence: "Introduced dbt models for the finance data mart." },
  ],
  missing_skills: [{ skill: "Kafka Streams", importance: "nice_to_have" }],
  strengths: ["Payments domain experience", "Production Spark at scale"],
  weaknesses: ["No Kafka Streams in production"],
  improvement_suggestions: [
    {
      area: "Streaming",
      suggestion: "Mention the Kafka ingestion you set up at Lumen.",
      priority: "medium",
    },
  ],
  summary: "A strong fit: payments data, Spark and Airflow at scale.",
};

function analysis(
  id: string,
  title: string,
  company: string,
  matchScore: number,
  sourceSite: string,
  documents: "READY" | null,
): Record<string, unknown> {
  return {
    id,
    status: "COMPLETED",
    matchScore,
    requestedAt: hoursAgo(3),
    requeuedAt: null,
    stuck: false,
    cvVersionId: CV_ID,
    ingestionJobId: "job-morning",
    // Left null: a non-null scoutId adds the row's "Scout" tag, and the
    // Landing page never shows that word (spec landing-v2).
    scoutId: null,
    applicationStatus: null,
    tailoredCvStatus: documents,
    coverLetterStatus: documents,
    jobOffer: {
      id: `offer-${id}`,
      title,
      company,
      location: "Paris",
      sourceSite,
      postedAt: hoursAgo(27),
      sourceUrl: "https://example.com/offer",
    },
    cvVersion: { label: "CV Data Engineer" },
    ingestionJob: { mode: "SITE_SEARCH", siteConfigId: "site-wttj" },
    resultJSON: id === PAYFLOW_ID ? PAYFLOW_RESULT : { ...PAYFLOW_RESULT, match_score: matchScore },
    errorMessage: null,
  };
}

const ANALYSES = {
  analyses: [
    analysis(PAYFLOW_ID, "Senior Data Engineer", "Payflow", 91, "WTTJ", "READY"),
    analysis("a2", "Data Engineer Spark", "Kessel", 84, "FRANCE_TRAVAIL", null),
    analysis("a3", "Analytics Engineer", "Novable", 76, "HELLOWORK", null),
  ],
};

const COVER_LETTER_MD = `# Senior Data Engineer — Payflow

Dear Payflow team,

Your Senior Data Engineer opening asks for someone who has run Spark and Airflow on payment data at scale. That is what I have done for the last four years at Lumen Pay.

There I rebuilt the batch platform that processes **2 TB of payment events a day**, cut its nightly run from five hours to forty minutes, and introduced dbt models that the finance team now reads every morning.

I would be glad to bring that experience to Payflow's data platform.

Kind regards,
Maya Restrepo`;

const TAILORED_CV_MD = `# Maya Restrepo

Senior Data Engineer · Paris · maya@example.com

## Experience

### Data Engineer — Lumen Pay (2021 – today)

- Rebuilt the Spark batch platform processing **2 TB of payment events a day**
- Orchestrated 60+ Airflow DAGs; nightly run cut from 5 h to 40 min
- Introduced dbt models for the finance data mart

### Data Analyst — Ordalie (2018 – 2021)

- Automated reconciliation reports in Python and SQL

## Skills

- Spark, Airflow, dbt, Python, SQL, Kafka

## Education

- MSc Computer Science — Université Paris-Saclay`;

function generatedDocument(
  id: string,
  type: "COVER_LETTER" | "TAILORED_CV",
  markdownContent: string,
): Record<string, unknown> {
  return {
    id,
    type,
    analysisId: PAYFLOW_ID,
    status: "READY",
    markdownContent,
    errorMessage: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  };
}

const COVER_LETTER = generatedDocument(COVER_LETTER_ID, "COVER_LETTER", COVER_LETTER_MD);
const TAILORED_CV = generatedDocument(TAILORED_CV_ID, "TAILORED_CV", TAILORED_CV_MD);

const QUOTAS = {
  activeScouts: { cap: 2, used: 1, remaining: 1 },
  analysesDaily: { cap: 15, used: 3, remaining: 12 },
  analysesMonthly: { cap: 300, used: 41, remaining: 259 },
  documentsDaily: { cap: 5, used: 2, remaining: 3 },
  alerts: [],
};

const CV_VERSIONS = { cvVersions: [{ id: CV_ID, label: "CV Data Engineer" }] };

const THEMES = ["light", "dark"] as const;

test("regenerate the Landing-page tailored CV screenshots", async ({ browser }) => {
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
    await page.route("**/api/analyses", (route) => route.fulfill(json(ANALYSES)));
    await page.route(`**/api/analyses/${PAYFLOW_ID}/generated-documents`, (route) =>
      route.fulfill(json({ generatedDocuments: [COVER_LETTER, TAILORED_CV] })),
    );
    await page.route(`**/api/generated-documents/${COVER_LETTER_ID}`, (route) =>
      route.fulfill(json({ generatedDocument: COVER_LETTER })),
    );
    await page.route(`**/api/generated-documents/${TAILORED_CV_ID}`, (route) =>
      route.fulfill(json({ generatedDocument: TAILORED_CV })),
    );
    await page.route("**/api/quotas", (route) => route.fulfill(json(QUOTAS)));
    await page.route("**/api/cv-versions**", (route) => route.fulfill(json(CV_VERSIONS)));

    await page.goto("/analyses");
    await page.getByRole("row").filter({ hasText: "Payflow" }).click();
    const panel = page.locator("[data-slot='sheet-content']");
    const documents = panel
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Generated documents" }) });
    await expect(documents.getByText("Maya Restrepo").first()).toBeVisible();
    await expect(documents.getByText("Download both")).toBeVisible();
    // Let the slide-in animation settle.
    await page.waitForTimeout(1000);

    await documents.screenshot({
      path: path.join(PUBLIC_DIR, `tailored-cv-${theme}.png`),
    });

    await context.close();
  }
});
