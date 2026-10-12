import { describe, expect, it, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "./msw/server";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth/react")>()),
  signOut,
}));

import { bff, BffError } from "@/lib/bff-client";

beforeEach(() => {
  signOut.mockReset();
});

describe("bff client", () => {
  it("returns the parsed JSON body on a 2xx response", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [{ id: "a1" }] }),
      ),
    );

    await expect(bff.get("/analyses")).resolves.toEqual({
      analyses: [{ id: "a1" }],
    });
  });

  it("serialises the body and forwards it on POST", async () => {
    let received: unknown;
    server.use(
      http.post("/api/ingestion-jobs", async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ id: "job-1" }, { status: 201 });
      }),
    );

    await expect(
      bff.post("/ingestion-jobs", { siteConfigId: "sc1" }),
    ).resolves.toEqual({ id: "job-1" });
    expect(received).toEqual({ siteConfigId: "sc1" });
  });

  it("throws BffError carrying the status and the server error message", async () => {
    server.use(
      http.get("/api/analyses/nope", () =>
        HttpResponse.json({ error: "Not found" }, { status: 404 }),
      ),
    );

    const err = (await bff.get("/analyses/nope").catch((e) => e)) as BffError;
    expect(err).toBeInstanceOf(BffError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
  });

  it("falls back to a generic message when the error body has no `error` field", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    );

    const err = (await bff.get("/analyses").catch((e) => e)) as BffError;
    expect(err).toBeInstanceOf(BffError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/failed with 500/);
  });

  // issue #144, docs/adr/0016: a blocked caller's next request anywhere
  // signs them out and routes them to a dedicated "account blocked" page.
  it("signs the caller out and redirects when the response is USER_BLOCKED", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json(
          { detail: { code: "USER_BLOCKED", message: "This account is blocked" } },
          { status: 403 },
        ),
      ),
    );

    await expect(bff.get("/scouts")).rejects.toBeInstanceOf(BffError);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/account-blocked" });
  });

  it("does not sign out on an ordinary 403 that isn't USER_BLOCKED", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({ error: "Forbidden" }, { status: 403 }),
      ),
    );

    await expect(bff.get("/scouts")).rejects.toBeInstanceOf(BffError);
    expect(signOut).not.toHaveBeenCalled();
  });
});

// issue #253: an expired Session makes every BFF route answer 401. The client
// signs the Candidate out once and sends them to /sign-in with their current
// page as callbackUrl, instead of surfacing a BffError to the page.
describe("bff client on an expired session (401)", () => {
  // The one-redirect guard lives for the page's lifetime, so each test loads
  // a fresh copy of the module.
  async function loadClient() {
    vi.resetModules();
    return import("@/lib/bff-client");
  }

  // Settles to "pending" if the request neither resolved nor rejected.
  async function outcomeOf(promise: Promise<unknown>) {
    return Promise.race([
      promise.then(
        () => "resolved",
        (err: unknown) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
  }

  beforeEach(() => {
    window.history.pushState({}, "", "/analyses?status=READY&sort=score#top");
  });

  it("signs out with the current path and query as callbackUrl, without throwing", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );
    const client = await loadClient();

    expect(await outcomeOf(client.bff.get("/analyses"))).toBe("pending");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({
      callbackUrl: "/analyses?status=READY&sort=score",
    });
  });

  it("signs out only once when parallel requests all get a 401", async () => {
    server.use(
      http.get("/api/*", () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );
    const client = await loadClient();

    const outcomes = await Promise.all([
      outcomeOf(client.bff.get("/analyses")),
      outcomeOf(client.bff.get("/scouts")),
      outcomeOf(client.bff.get("/applications")),
    ]);

    expect(outcomes).toEqual(["pending", "pending", "pending"]);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("routes a USER_BLOCKED 401 to /account-blocked, not to /sign-in", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json(
          { detail: { code: "USER_BLOCKED", message: "This account is blocked" } },
          { status: 401 },
        ),
      ),
    );
    const client = await loadClient();

    await expect(client.bff.get("/scouts")).rejects.toBeInstanceOf(client.BffError);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/account-blocked" });
  });

  it.each([429, 500])("still throws a BffError on a %i and does not sign out", async (status) => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ error: "Nope" }, { status }),
      ),
    );
    const client = await loadClient();

    const err = (await client.bff.get("/analyses").catch((e) => e)) as BffError;
    expect(err).toBeInstanceOf(client.BffError);
    expect(err.status).toBe(status);
    expect(signOut).not.toHaveBeenCalled();
  });
});
