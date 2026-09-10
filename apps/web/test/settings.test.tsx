import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Session } from "next-auth";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import SettingsPage from "@/app/(app)/settings/page";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth/react")>()),
  signOut,
}));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" },
};

beforeEach(() => {
  signOut.mockReset();
});

describe("SettingsPage", () => {
  it("exposes the theme and language controls", () => {
    renderWithProviders(<SettingsPage />, { session: SESSION });

    expect(
      screen.getByRole("button", { name: "Change theme" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Language" }),
    ).toBeInTheDocument();
  });

  it("changes the theme from the page", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Change theme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dark" }));

    await waitFor(() => {
      expect(document.documentElement).toHaveClass("dark");
    });
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });

  it("shows the Session's name and email with no way to edit them", () => {
    renderWithProviders(<SettingsPage />, { session: SESSION });

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("signs out when the sign-out action is used", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalled();
  });
});
