import fs from "node:fs";
import path from "node:path";

/** Loads `<rootDir>/.env`, the repo's single env file (#255), into
 *  process.env. A variable already set (shell, CI, compose `env_file`, or an
 *  apps/web/.env Next loaded first) wins over the file. No file is fine:
 *  Docker images don't ship one, their env comes from compose. */
export function loadRootEnv(rootDir: string): void {
  const file = path.join(rootDir, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
