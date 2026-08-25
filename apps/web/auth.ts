import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import LinkedIn from "next-auth/providers/linkedin";
import Nodemailer from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";
import { prisma } from "@/lib/prisma";

// Falls back to nodemailer's `jsonTransport` (no real SMTP connection) when
// EMAIL_SERVER isn't configured, so the magic-link flow is exercisable in
// local dev/CI without a mail server. The link is also logged to the server
// console outside production so it can be followed manually or by a script.
const emailServer = process.env.EMAIL_SERVER || { jsonTransport: true as const };

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
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
