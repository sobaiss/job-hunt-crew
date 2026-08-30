import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Route protection for the signed-in area. Next 16 renamed the `middleware`
// convention to `proxy` (same behaviour, now Node.js runtime by default); this
// is what the spec calls "middleware.ts".
//
// This is a *presence check only* — it never verifies the JWT signature (that
// stays with `auth()` on the server, consistent with the M7 header-trust model
// and its documented risks), so it deliberately does not import `auth.ts` and
// just inspects the request cookies.
//
// The matcher below is the allow-list's inverse: `/`, `/sign-in`,
// `/api/auth/*` and static assets are simply never matched, so they stay
// public. Everything else requires a NextAuth session cookie; without one the
// request is bounced to `/sign-in` carrying the originally requested path as
// `callbackUrl` so the user is returned there after authenticating.
const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

export function proxy(request: NextRequest) {
  const hasSession = SESSION_COOKIES.some((name) =>
    request.cookies.has(name),
  );
  if (hasSession) {
    return NextResponse.next();
  }

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set(
    "callbackUrl",
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    "/analyses/:path*",
    "/cv-versions/:path*",
    "/ingestion-jobs/:path*",
  ],
};
