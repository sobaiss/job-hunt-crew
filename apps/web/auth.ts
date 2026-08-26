import NextAuth from "next-auth";
import type { Adapter } from "next-auth/adapters";
import Google from "next-auth/providers/google";
import LinkedIn from "next-auth/providers/linkedin";
import Nodemailer from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";
import { internalApiFetch, upsertUser } from "@/lib/internal-api";

// Falls back to nodemailer's `jsonTransport` (no real SMTP connection) when
// EMAIL_SERVER isn't configured, so the magic-link flow is exercisable in
// local dev/CI without a mail server. The link is also logged to the server
// console outside production so it can be followed manually or by a script.
const emailServer = process.env.EMAIL_SERVER || { jsonTransport: true as const };

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
        token.userId = await upsertUser({ email: user.email, name: user.name, image: user.image });
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
  providers: [
    Google,
    LinkedIn,
    Nodemailer({
      server: emailServer,
      from: process.env.EMAIL_FROM || "Job Hunt Crew <no-reply@job-hunt-crew.local>",
      async sendVerificationRequest({ identifier, url, provider }) {
        if (process.env.NODE_ENV !== "production") {
          console.log(`[auth] magic link for ${identifier}: ${url}`);
        }
        const transport = createTransport(provider.server);
        await transport.sendMail({
          to: identifier,
          from: provider.from,
          subject: "Sign in to job-hunt-crew",
          text: `Sign in to job-hunt-crew: ${url}`,
          html: `<p><a href="${url}">Sign in to job-hunt-crew</a></p>`,
        });
      },
    }),
  ],
});
