import type { DefaultSession } from "next-auth";

// A User's usage tier (see services/api's Plan glossary entry) — kept as a
// plain string union here rather than importing py_db's enum, since apps/web
// never depends on the API's Python package.
export type Plan = "FREE" | "STANDARD" | "PREMIUM" | "ADMINISTRATEUR";

// A User's access level, decoupled from Plan (issue #153/#156,
// docs/adr/0017), replacing the retired `isAdmin` boolean from issue #144.
export type Role = "EXTERNAL" | "INTERNAL" | "ADMINISTRATOR";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      plan?: Plan;
      role?: Role;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    plan?: Plan;
    role?: Role;
  }
}
