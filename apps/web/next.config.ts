import path from "node:path";

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { loadRootEnv } from "./lib/root-env";

// The whole repo reads one root `.env` (#255, see ../../.env.example), not an
// apps/web/.env. Loaded here so `pnpm dev`, `next build` and `next start` all
// see it; anything already in the environment wins.
const repoRoot = path.resolve(__dirname, "..", "..");
loadRootEnv(repoRoot);

// Wires i18n/request.ts (the default path) into the build so server components
// and `getLocale()` / `getMessages()` resolve the active Locale per request.
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // `.next/standalone`: a self-contained server.js plus only the node_modules
  // it needs, which the production image (Dockerfile.production, docs/adr/0034)
  // runs. `next dev` / `next start` ignore it.
  output: "standalone",
  // pnpm hoists dependencies to the workspace root; tracing from there puts
  // them in the standalone tree (as standalone/apps/web/server.js).
  outputFileTracingRoot: repoRoot,
};

export default withNextIntl(nextConfig);
