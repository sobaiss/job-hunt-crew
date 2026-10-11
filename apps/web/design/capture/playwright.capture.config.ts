import { defineConfig, devices } from "@playwright/test";

// A standalone Playwright config, *not* part of `pnpm test:e2e` (which only
// scans ./e2e). Each scenario drives a real signed-in screen and writes a
// light / dark screenshot pair to public/: the Agent panel the Landing page's
// #agents section shows (agent-panel.capture.spec.ts), and the Dashboard
// (dashboard.capture.spec.ts).
//
// Run it by hand when one of those screens changes (append a file name to run
// a single scenario):
//
//   pnpm exec playwright test --config design/capture/playwright.capture.config.ts
//
// Start `pnpm exec next dev --webpack` from apps/web first: the webServer
// below is started from this folder, where next-intl cannot find
// i18n/request.ts, so it only works when it reuses an existing server.
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
