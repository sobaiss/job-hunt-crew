import { describe, expect, it } from "vitest";

import { authProviders } from "@/lib/auth-providers";
import { signInMethods, type SignInMethods } from "@/lib/sign-in-methods";

// #258: the sign-in page and the Auth.js provider list offer only what this
// installation has configured. Password sign-in is always there.
describe("signInMethods", () => {
  it("offers email + password only when nothing optional is configured", () => {
    expect(signInMethods({ NODE_ENV: "production" })).toEqual({
      google: false,
      linkedin: false,
      magicLink: false,
    });
  });

  it("offers Google once both its client id and secret are set", () => {
    expect(
      signInMethods({ NODE_ENV: "production", AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" }),
    ).toEqual({ google: true, linkedin: false, magicLink: false });
  });

  it("offers LinkedIn once both its client id and secret are set", () => {
    expect(
      signInMethods({ NODE_ENV: "production", AUTH_LINKEDIN_ID: "id", AUTH_LINKEDIN_SECRET: "secret" }),
    ).toEqual({ google: false, linkedin: true, magicLink: false });
  });

  it("does not offer a provider with only half its credentials", () => {
    expect(
      signInMethods({ NODE_ENV: "production", AUTH_GOOGLE_ID: "id", AUTH_LINKEDIN_SECRET: "secret" }),
    ).toEqual({ google: false, linkedin: false, magicLink: false });
  });

  it("offers the magic link once an email server is set", () => {
    expect(
      signInMethods({ NODE_ENV: "production", EMAIL_SERVER: "smtp://u:p@smtp.example.org:587" }),
    ).toEqual({ google: false, linkedin: false, magicLink: true });
  });

  it("keeps the console-logged magic link in development only", () => {
    expect(signInMethods({ NODE_ENV: "development" }).magicLink).toBe(true);
    expect(signInMethods({ NODE_ENV: "test" }).magicLink).toBe(false);
    expect(signInMethods({}).magicLink).toBe(false);
  });

  it("treats blank values as unset", () => {
    expect(
      signInMethods({ NODE_ENV: "production", AUTH_GOOGLE_ID: " ", AUTH_GOOGLE_SECRET: "", EMAIL_SERVER: "" }),
    ).toEqual({ google: false, linkedin: false, magicLink: false });
  });
});

describe("authProviders", () => {
  // Auth.js accepts a provider either as its config or as the factory itself
  // (Google, LinkedIn are passed uncalled so Auth.js fills AUTH_* in).
  function ids(methods: SignInMethods): string[] {
    return authProviders(methods).map((provider) =>
      typeof provider === "function" ? provider().id : provider.id,
    );
  }

  it("holds only credentials when nothing optional is configured", () => {
    expect(ids({ google: false, linkedin: false, magicLink: false })).toEqual(["credentials"]);
  });

  it("adds exactly the configured providers", () => {
    expect(ids({ google: true, linkedin: false, magicLink: false })).toEqual(["google", "credentials"]);
    expect(ids({ google: false, linkedin: true, magicLink: false })).toEqual(["linkedin", "credentials"]);
    expect(ids({ google: false, linkedin: false, magicLink: true })).toEqual(["credentials", "nodemailer"]);
    expect(ids({ google: true, linkedin: true, magicLink: true })).toEqual([
      "google",
      "linkedin",
      "credentials",
      "nodemailer",
    ]);
  });
});
