import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import LinkedIn from "next-auth/providers/linkedin";
import Nodemailer from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";

import { verifyCredentials } from "@/lib/internal-api";
import type { SignInMethods } from "@/lib/sign-in-methods";

/** The Auth.js provider list for the configured sign-in methods (#258): an
 *  unconfigured provider is absent, so it can't be reached by URL either.
 *  Credentials (email + password) is always there. */
export function authProviders(methods: SignInMethods): Provider[] {
  const providers: Provider[] = [];
  if (methods.google) providers.push(Google);
  if (methods.linkedin) providers.push(LinkedIn);
  providers.push(
    Credentials({
      // Email is the login, per the sign-in page's password option. The one
      // /internal/auth/verify-credentials call covers "unknown email", "no
      // password set" (an OAuth/magic-link-only User), and "wrong password"
      // identically, so `authorize` never needs to (and can't) tell them
      // apart itself. On success it returns just `{ id, email }` — the `jwt`
      // callback in auth.ts re-derives userId/role the same way every other
      // provider does, via `upsertUser`, rather than special-casing this one.
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email : null;
        const password = typeof credentials?.password === "string" ? credentials.password : null;
        if (!email || !password) return null;
        const verified = await verifyCredentials({ email, password });
        if (!verified) return null;
        return { id: verified.userId, email };
      },
    }),
  );
  if (methods.magicLink) {
    providers.push(
      Nodemailer({
        // Falls back to nodemailer's `jsonTransport` (no real SMTP connection)
        // when EMAIL_SERVER isn't configured — which signInMethods only allows
        // under `next dev` — so the magic-link flow is exercisable without a
        // mail server. The link is also logged to the server console outside
        // production so it can be followed manually or by a script.
        server: process.env.EMAIL_SERVER || { jsonTransport: true as const },
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
    );
  }
  return providers;
}
