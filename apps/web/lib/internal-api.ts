// Thin client for services/api's internal (non-/v1) and /v1 surfaces
// (PRD Section 9.2). Used only from server-side code (auth.ts, and the
// app/api/* BFF proxy routes) that must reach Postgres/S3/SQS without ever
// depending on Prisma/aws-sdk directly, per the M7 frontend/backend split.

import type { Session } from "next-auth";
import type { Role } from "@/types/next-auth";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

// The single place the X-User-Id/X-User-Role header pair is built from a
// Session (issue #152, updated for Role by issue #156) — every admin BFF
// route forwards through this instead of constructing the pair inline.
// Returns null when there's no authenticated user, so callers can 401
// uniformly. A session with no Role (shouldn't happen once `jwt` always
// resolves one, but not provable at the type level) defaults to the lowest
// privilege, EXTERNAL, same as the User model's own column default.
export function adminSessionHeaders(session: Session | null): Record<string, string> | null {
  if (!session?.user?.id) {
    return null;
  }
  return {
    "X-User-Id": session.user.id,
    "X-User-Role": session.user.role ?? "EXTERNAL",
  };
}

export function internalApiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Api-Secret": INTERNAL_API_SECRET,
      ...init?.headers,
    },
  });
}

// Forwards a request to services/api's /v1/* surface and passes the response
// straight through, so BFF routes stay thin proxies (PRD Section 7/9.1). On
// a network-level failure (the api service is down/unreachable) this returns
// a clear 502 instead of letting the caller hang or throw an unhandled error.
export async function proxyToApi(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await internalApiFetch(path, init);
  } catch {
    return new Response(JSON.stringify({ error: "Upstream service unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  // arrayBuffer (not text) so binary bodies (e.g. the document-download route)
  // pass through byte-for-byte instead of being mangled by a UTF-8 round-trip.
  const body = await res.arrayBuffer();
  const headers: Record<string, string> = {
    "Content-Type": res.headers.get("Content-Type") || "application/json",
  };
  // Forwarded so the browser picks up the per-format filename/extension the
  // document-download route sets (see generated-documents-panel.tsx).
  const contentDisposition = res.headers.get("Content-Disposition");
  if (contentDisposition) {
    headers["Content-Disposition"] = contentDisposition;
  }
  return new Response(body, { status: res.status, headers });
}

export async function upsertUser(params: {
  email: string;
  name?: string | null;
  image?: string | null;
}): Promise<{ userId: string; role: Role }> {
  const res = await internalApiFetch("/internal/users/upsert", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      name: params.name ?? undefined,
      image: params.image ?? undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to upsert user (${res.status})`);
  }
  const data = (await res.json()) as { userId: string; role: Role };
  return data;
}

// Backs the Credentials provider's `authorize`. Returns `null` (never
// throws) on a 401 — invalid email, unknown email, and "no password set" are
// all the same outcome from here, matching the endpoint's generic response.
export async function verifyCredentials(params: {
  email: string;
  password: string;
}): Promise<{ userId: string; role: Role } | null> {
  const res = await internalApiFetch("/internal/auth/verify-credentials", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as { userId: string; role: Role };
}
