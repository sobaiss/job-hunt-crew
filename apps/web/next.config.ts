import path from "node:path";

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { loadRootEnv } from "./lib/root-env";

// The whole repo reads one root `.env` (#255, see ../../.env.example), not an
// apps/web/.env. Loaded here so `pnpm dev`, `next build` and `next start` all
// see it; anything already in the environment wins.
loadRootEnv(path.resolve(__dirname, "..", ".."));

// Wires i18n/request.ts (the default path) into the build so server components
// and `getLocale()` / `getMessages()` resolve the active Locale per request.
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  /* config options here */
};

export default withNextIntl(nextConfig);
