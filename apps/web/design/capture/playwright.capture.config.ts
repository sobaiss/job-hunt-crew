import { defineConfig, devices } from "@playwright/test";

// A standalone Playwright config, *not* part of `pnpm test:e2e` (which only
// scans ./e2e). It drives a real signed-in Dashboard and writes the two
// screenshots the marketing Landing page embeds as its product preview
// (spec #49 — "a real screenshot of the redesigned Dashboard, not a mock").
//
// Run it by hand when the Dashboard changes:
//
//   pnpm exec playwright test --config design/capture/playwright.capture.config.ts
//
// All `/api/*` traffic is faked in the spec, and the signed-in session is a
// locally-minted JWT — no backend and no real auth provider are involved.
export default defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Same stable bundler the e2e config uses — Turbopack's dev server panics
    // writing its chunk cache on some filesystems.
    command: "pnpm exec next dev --webpack",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
