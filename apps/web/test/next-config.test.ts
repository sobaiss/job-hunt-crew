import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import nextConfig from "../next.config";

// Identity stand-in: the assertions are about this repo's config, not the
// plugin's wrapping (which also loads a native file watcher).
vi.mock("next-intl/plugin", () => ({
  default: () => (config: unknown) => config,
}));

// The production image (apps/web/Dockerfile.production, docs/adr/0034) copies
// `.next/standalone` and runs its server.js: that tree only exists with
// `output: "standalone"`, and only includes the workspace's hoisted
// node_modules when tracing starts at the repo root.
describe("next.config", () => {
  it("builds a standalone server", () => {
    expect(nextConfig.output).toBe("standalone");
  });

  it("traces files from the repo root (pnpm workspace)", () => {
    expect(nextConfig.outputFileTracingRoot).toBe(path.resolve(__dirname, "..", "..", ".."));
  });
});
