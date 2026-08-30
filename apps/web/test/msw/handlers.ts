import { http, HttpResponse } from "msw";

// The single MSW handler set: the only fake in Seam 1 (the HTTP boundary).
// Later tickets add the real BFF route handlers here; for now one example
// handler proves the wiring — the request is intercepted, not sent.
export const handlers = [
  http.get("/api/example", () => HttpResponse.json({ ok: true })),
];
