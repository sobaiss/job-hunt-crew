import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRootEnv } from "@/lib/root-env";

// apps/web reads the repo's single root `.env` (#255): next.config.ts calls
// loadRootEnv with the repo root, for `pnpm dev` and `next build` alike.
describe("loadRootEnv", () => {
  let dir: string;
  const keys = ["ROOT_ENV_TEST_A", "ROOT_ENV_TEST_B"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-env-"));
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of keys) delete process.env[key];
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
});
