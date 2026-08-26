// Thin client for services/api's internal (non-/v1) and /v1 surfaces
// (PRD Section 9.2). Used only from server-side code (auth.ts, and the
// app/api/* BFF proxy routes) that must reach Postgres/S3/SQS without ever
// depending on Prisma/aws-sdk directly, per the M7 frontend/backend split.

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

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
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
  });
}

export async function upsertUser(params: {
  email: string;
  name?: string | null;
  image?: string | null;
}): Promise<string> {
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
  const data = (await res.json()) as { userId: string };
  return data.userId;
}
