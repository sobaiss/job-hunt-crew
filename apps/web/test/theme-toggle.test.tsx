import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { ThemeToggle } from "@/components/theme-toggle";

async function choose(theme: "Light" | "Dark" | "System") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Change theme" }));
  await user.click(await screen.findByRole("menuitem", { name: theme }));
}

describe("ThemeToggle", () => {
  it("applies the dark class and persists the choice when Dark is picked", async () => {
    renderWithProviders(<ThemeToggle />);

    await choose("Dark");

    await waitFor(() => {
      expect(document.documentElement).toHaveClass("dark");
    });
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });

  it("removes the dark class and persists the choice when Light is picked", async () => {
    renderWithProviders(<ThemeToggle />, { theme: "dark" });

    await choose("Light");

    await waitFor(() => {
      expect(document.documentElement).not.toHaveClass("dark");
    });
    expect(window.localStorage.getItem("theme")).toBe("light");
  });
});
