import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Session } from "next-auth";

import { renderWithProviders, screen, within, waitFor } from "./test-utils";
import { AppHeader } from "@/components/app-header";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next-auth/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth/react")>()),
  signOut,
}));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
let pathname = "/analyses";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => pathname,
}));

const SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" },
};

beforeEach(() => {
  signOut.mockReset();
  pathname = "/analyses";
});

describe("AppHeader", () => {
  it("renders the primary navigation links to the main areas", () => {
    renderWithProviders(<AppHeader />, { session: SESSION });

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/analyses",
    );
    expect(screen.getByRole("link", { name: "CV versions" })).toHaveAttribute(
      "href",
      "/cv-versions",
    );
    expect(screen.getByRole("link", { name: "New analysis" })).toHaveAttribute(
      "href",
      "/analyses/new",
    );
  });

  it("opens the user menu and invokes signOut when Sign out is chosen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppHeader />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalled();
  });

  it("exposes the theme and language controls inside the user menu", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppHeader />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    expect(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change theme" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Language" })).toBeInTheDocument();
  });

  it("opens the mobile navigation Sheet and closes it on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppHeader />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Open menu" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: "New analysis" }),
    ).toHaveAttribute("href", "/analyses/new");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
