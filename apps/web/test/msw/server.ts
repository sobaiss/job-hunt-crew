import { setupServer } from "msw/node";
import { handlers } from "./handlers";

// Shared MSW server for Vitest. Lifecycle (listen / resetHandlers / close) is
// wired in test/setup.ts so every test starts from the same handler set.
export const server = setupServer(...handlers);
