import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./msw/server";

// jsdom is missing a handful of DOM APIs that next-themes and the Radix
// primitives (DropdownMenu, Select, Dialog) touch. Stub the ones they need so
// component tests exercise real interaction code instead of crashing.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

for (const method of [
  "scrollIntoView",
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
] as const) {
  if (!(method in Element.prototype)) {
    Element.prototype[method] = vi.fn();
  }
}

// Seam 1: intercept every HTTP call at the network boundary. `onUnhandledRequest:
// "error"` keeps the fake honest — a test that reaches an unmocked endpoint fails
// loudly instead of hitting the real network.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  // next-themes persists to localStorage and mutates <html>; the LocaleSwitch
  // writes a cookie and sets <html lang>. Reset all of it so tests don't leak.
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  document.documentElement.removeAttribute("lang");
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=;path=/;max-age=0`;
    }
  }
});

afterAll(() => server.close());
