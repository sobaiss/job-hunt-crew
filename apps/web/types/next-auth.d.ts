import type { DefaultSession } from "next-auth";

// A User's access level, decoupled from Plan/Subscription (issue #153/#156,
// docs/adr/0017), replacing the retired `isAdmin` boolean from issue #144.
export type Role = "EXTERNAL" | "INTERNAL" | "ADMINISTRATOR";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role?: Role;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: Role;
  }
}
