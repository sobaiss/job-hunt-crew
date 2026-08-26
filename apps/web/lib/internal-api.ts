// Thin client for services/api's internal (non-/v1) surface (PRD Section 9.2).
// Used only from server-side code (e.g. auth.ts) that must reach Postgres
// without ever depending on Prisma directly, per the M7 frontend/backend split.

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
