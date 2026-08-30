import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";

describe("test harness", () => {
  it("renders a component through renderWithProviders", () => {
    renderWithProviders(<h1>Job Hunt Crew</h1>);
    expect(
      screen.getByRole("heading", { level: 1, name: "Job Hunt Crew" }),
    ).toBeInTheDocument();
  });

  it("intercepts HTTP calls with the MSW example handler", async () => {
    const res = await fetch("/api/example");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("lets a test override a handler for its own case", async () => {
    server.use(
      http.get("/api/example", () =>
        HttpResponse.json({ ok: false }, { status: 503 }),
      ),
    );
    const res = await fetch("/api/example");
    expect(res.status).toBe(503);
  });
});
