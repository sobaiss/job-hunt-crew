import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./msw/server";

// Seam 1: intercept every HTTP call at the network boundary. `onUnhandledRequest:
// "error"` keeps the fake honest — a test that reaches an unmocked endpoint fails
// loudly instead of hitting the real network.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
