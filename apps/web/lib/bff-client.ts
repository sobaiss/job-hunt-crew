// Typed browser-side client for the BFF routes under `/api/*` (the Next.js
// route handlers in `app/api`, which proxy to services/api). Every read hook
// and mutation in the restyle tickets goes through this one wrapper so error
// handling and JSON parsing live in a single place.
//
// Server-side code (auth.ts, the BFF routes themselves) does NOT use this —
// it talks to services/api directly via `lib/internal-api.ts`.

import { signOut } from "next-auth/react";

/** Thrown for any non-2xx BFF response. Carries the HTTP status and parsed body. */
export class BffError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BffError";
    this.status = status;
    this.body = body;
  }
}

const BASE = "/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// services/api's `require_user_id` rejects a blocked caller with this
// distinguishable shape (issue #144, docs/adr/0016), forwarded through the
// BFF proxy unchanged. Signs the Candidate out and routes them to a
// dedicated "account blocked" page immediately, rather than surfacing this
// as a generic per-request error — this takes effect even against an
// already-active session, independent of the JWT's remaining lifetime.
function isBlockedResponse(data: unknown): boolean {
  return isRecord(data) && isRecord(data.detail) && data.detail.code === "USER_BLOCKED";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new BffError(`Network error requesting ${path}`, 0, cause);
  }

  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    if (isBlockedResponse(data)) {
      void signOut({ callbackUrl: "/account-blocked" });
    }
    const message =
      isRecord(data) && typeof data.error === "string"
        ? data.error
        : `Request to ${path} failed with ${response.status}`;
    throw new BffError(message, response.status, data);
  }

  return data as T;
}

/**
 * The BFF surface. `body` is JSON-serialised for you; pass a plain object.
 * Callers supply the response type: `bff.get<{ analyses: Analysis[] }>("/analyses")`.
 */
export const bff = {
  get: <T>(path: string, init?: Omit<RequestInit, "method" | "body">) =>
    request<T>(path, { ...init, method: "GET" }),

  post: <T>(
    path: string,
    body?: unknown,
    init?: Omit<RequestInit, "method" | "body">,
  ) =>
    request<T>(path, {
      ...init,
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  patch: <T>(
    path: string,
    body?: unknown,
    init?: Omit<RequestInit, "method" | "body">,
  ) =>
    request<T>(path, {
      ...init,
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  put: <T>(
    path: string,
    body?: unknown,
    init?: Omit<RequestInit, "method" | "body">,
  ) =>
    request<T>(path, {
      ...init,
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  delete: <T>(path: string, init?: Omit<RequestInit, "method" | "body">) =>
    request<T>(path, { ...init, method: "DELETE" }),
};
