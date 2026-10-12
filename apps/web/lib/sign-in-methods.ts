/** The optional sign-in methods this installation has configured (#258).
 *  Email + password is always available, so it isn't listed.
 *
 *  - Google / LinkedIn: both the client id and the secret are set (the
 *    AUTH_* names Auth.js reads).
 *  - Magic link: EMAIL_SERVER is set. Without one, `next dev` still offers it
 *    and logs the link to the server console (the contributor fallback); a
 *    production build, or a test run, doesn't.
 *
 *  Read at request time, so a production image follows its runtime .env. */
export interface SignInMethods {
  google: boolean;
  linkedin: boolean;
  magicLink: boolean;
}

type Env = Record<string, string | undefined>;

function isSet(env: Env, key: string): boolean {
  return (env[key] ?? "").trim() !== "";
}

export function signInMethods(env: Env = process.env): SignInMethods {
  return {
    google: isSet(env, "AUTH_GOOGLE_ID") && isSet(env, "AUTH_GOOGLE_SECRET"),
    linkedin: isSet(env, "AUTH_LINKEDIN_ID") && isSet(env, "AUTH_LINKEDIN_SECRET"),
    magicLink: isSet(env, "EMAIL_SERVER") || env.NODE_ENV === "development",
  };
}
