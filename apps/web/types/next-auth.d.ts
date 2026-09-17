import type { DefaultSession } from "next-auth";

// A User's usage tier (see services/api's Plan glossary entry) — kept as a
// plain string union here rather than importing py_db's enum, since apps/web
// never depends on the API's Python package.
export type Plan = "FREE" | "STANDARD" | "PREMIUM" | "ADMINISTRATEUR";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      plan?: Plan;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    plan?: Plan;
  }
}
