import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Session } from "next-auth";

import { renderWithProviders, screen, within, waitFor } from "./test-utils";
import { AppSidebar } from "@/components/app-sidebar";
import { AppTopbar } from "@/components/app-topbar";

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

describe("AppSidebar", () => {
  it("links every nav item to its area", () => {
    renderWithProviders(<AppSidebar />, { session: SESSION });

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: "Analyses" })).toHaveAttribute(
      "href",
      "/analyses",
    );
    expect(screen.getByRole("link", { name: "CV versions" })).toHaveAttribute(
      "href",
      "/cv-versions",
    );
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("exposes a New analysis primary action pointing at the single-offer flow", () => {
    renderWithProviders(<AppSidebar />, { session: SESSION });

    expect(screen.getByRole("link", { name: "New analysis" })).toHaveAttribute(
      "href",
      "/analyses/new",
    );
  });

  it("marks the current route with aria-current and leaves the others unmarked", () => {
    pathname = "/analyses";
    renderWithProviders(<AppSidebar />, { session: SESSION });

    expect(screen.getByRole("link", { name: "Analyses" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Dashboard" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("marks Dashboard active only on an exact / match", () => {
    pathname = "/";
    renderWithProviders(<AppSidebar />, { session: SESSION });

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Analyses" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("opens the account menu and invokes signOut when Sign out is chosen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppSidebar />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalled();
  });

  it("exposes the theme and language controls inside the account menu", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppSidebar />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    expect(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change theme" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Language" })).toBeInTheDocument();
  });
});

describe("AppTopbar", () => {
  it("names the current page", () => {
    pathname = "/cv-versions";
    renderWithProviders(<AppTopbar />, { session: SESSION });

    expect(
      screen.getByRole("heading", { name: "CV versions" }),
    ).toBeInTheDocument();
  });

  it("names a nested route by its section", () => {
    pathname = "/analyses/new";
    renderWithProviders(<AppTopbar />, { session: SESSION });

    expect(screen.getByRole("heading", { name: "Analyses" })).toBeInTheDocument();
  });

  it("opens the navigation drawer from the Topbar and closes it on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppTopbar />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Open menu" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: "Analyses" }),
    ).toHaveAttribute("href", "/analyses");
    expect(
      within(dialog).getByRole("link", { name: "New analysis" }),
    ).toHaveAttribute("href", "/analyses/new");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
