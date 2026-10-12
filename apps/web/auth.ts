import NextAuth from "next-auth";
import type { Adapter } from "next-auth/adapters";
import { authProviders } from "@/lib/auth-providers";
import { internalApiFetch, upsertUser } from "@/lib/internal-api";
import { signInMethods } from "@/lib/sign-in-methods";

// Auth.js requires *some* Adapter whenever an Email provider is configured
// (validated at startup) and, once one is configured, its OAuth account-
// linking codepath (handleLoginOrRegister) unconditionally calls a handful
// of the adapter's other methods too — even though the app runs with JWT
// sessions and never persists Session/Account/User rows here. Postgres is
// no longer touched from apps/web at all (M7): the only real work this
// adapter does is proxy verification tokens to services/api; every other
// method is a stateless stub whose return value next-auth discards once the
// `jwt` callback below re-derives the canonical userId from
// /internal/users/upsert (keyed by email, unifying Email + OAuth sign-in).
const verificationTokenAdapter: Adapter = {
  async createVerificationToken(verificationToken) {
    const res = await internalApiFetch("/internal/auth/verification-tokens", {
      method: "POST",
      body: JSON.stringify(verificationToken),
    });
    if (!res.ok) {
      throw new Error(`Failed to create verification token (${res.status})`);
    }
    return verificationToken;
  },
  async useVerificationToken({ identifier, token }) {
    const res = await internalApiFetch("/internal/auth/verification-tokens/consume", {
      method: "POST",
      body: JSON.stringify({ identifier, token }),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to consume verification token (${res.status})`);
    }
    const data = await res.json();
    return { identifier: data.identifier, token: data.token, expires: new Date(data.expires) };
  },
  async getUserByEmail() {
    return null;
  },
  async getUserByAccount() {
    return null;
  },
  async createUser(user) {
    return { ...user, id: user.id ?? crypto.randomUUID(), emailVerified: user.emailVerified ?? null };
  },
  async linkAccount() {
    return undefined;
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: verificationTokenAdapter,
  session: {
    strategy: "jwt",
    // Short-lived per PRD Section 14: JWT sessions can't be revoked
    // server-side on demand, so a 30-minute maxAge (vs. the 30-day default)
    // bounds how long a stolen/leaked token stays valid.
    maxAge: 60 * 30,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.email) {
        const upserted = await upsertUser({ email: user.email, name: user.name, image: user.image });
        token.userId = upserted.userId;
        token.role = upserted.role;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      session.user.role = token.role ?? "EXTERNAL";
      return session;
    },
  },
  providers: authProviders(signInMethods()),
});
