import { defineConfig, devices } from "@playwright/test";

// Seam 2: the real browser. Only covers what jsdom cannot (proxy/middleware
// redirects, no-flash-of-wrong-theme, reload persistence). All `/api/*` traffic
// is faked in the test via the shared helper in ./e2e/network-stub.ts — no
// backend runs.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // `--webpack`: the Turbopack dev server (the `next dev` default) panics
    // while writing its chunk cache on some filesystems ("File exists (os
    // error 17)"). The repo already builds with `next build --webpack` for the
    // same reason; keep the e2e dev server on the stable bundler too.
    command: "pnpm exec next dev --webpack",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
