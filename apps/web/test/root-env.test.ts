import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRootEnv } from "@/lib/root-env";

// apps/web reads the repo's single root `.env` (#255): next.config.ts calls
// loadRootEnv with the repo root, for `pnpm dev` and `next build` alike.
describe("loadRootEnv", () => {
  let dir: string;
  const keys = ["ROOT_ENV_TEST_A", "ROOT_ENV_TEST_B", "APP_URL", "AUTH_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-env-"));
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("loads the .env in the given directory into process.env", () => {
    fs.writeFileSync(path.join(dir, ".env"), 'ROOT_ENV_TEST_A="from root"\n');

    loadRootEnv(dir);

    expect(process.env.ROOT_ENV_TEST_A).toBe("from root");
  });

  it("never overrides a variable the environment already sets", () => {
    fs.writeFileSync(
      path.join(dir, ".env"),
      "ROOT_ENV_TEST_A=from-root\nROOT_ENV_TEST_B=from-root\n",
    );
    process.env.ROOT_ENV_TEST_A = "from-shell";

    loadRootEnv(dir);

    expect(process.env.ROOT_ENV_TEST_A).toBe("from-shell");
    expect(process.env.ROOT_ENV_TEST_B).toBe("from-root");
  });

  it("does nothing when there is no .env (e.g. inside a Docker image)", () => {
    expect(() => loadRootEnv(dir)).not.toThrow();
    expect(process.env.ROOT_ENV_TEST_A).toBeUndefined();
  });

  // #263: `make setup` writes APP_URL; Auth.js reads AUTH_URL.
  it("makes APP_URL the Auth.js URL (AUTH_URL)", () => {
    fs.writeFileSync(path.join(dir, ".env"), 'APP_URL="https://jobs.example.org"\n');

    loadRootEnv(dir);

    expect(process.env.AUTH_URL).toBe("https://jobs.example.org");
  });

  it("keeps an AUTH_URL the environment already sets", () => {
    fs.writeFileSync(path.join(dir, ".env"), 'APP_URL="https://jobs.example.org"\n');
    process.env.AUTH_URL = "http://from-shell:3000";

    loadRootEnv(dir);

    expect(process.env.AUTH_URL).toBe("http://from-shell:3000");
  });

  it("sets no AUTH_URL without an APP_URL", () => {
    loadRootEnv(dir);

    expect(process.env.AUTH_URL).toBeUndefined();
  });
});
