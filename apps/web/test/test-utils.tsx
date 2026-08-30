import type { ReactElement } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";

// The shared entry point for component/integration tests. For now it is a thin
// pass-through over RTL `render`; later foundation tickets grow it to supply the
// theme, i18n, Session and QueryClient providers (with a settable fake Session
// and Locale) so page tests get the full context in one call.
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
  return render(ui, options);
}

export * from "@testing-library/react";
