import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "./msw/server";
import { bff, BffError } from "@/lib/bff-client";

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
});
