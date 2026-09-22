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

const ADMIN_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: {
    id: "admin_1",
    name: "Grace Hopper",
    email: "grace@example.com",
    role: "ADMINISTRATOR",
  },
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
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute(
      "href",
      "/scouts",
    );
    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute(
      "href",
      "/applications",
    );
    expect(screen.getByRole("link", { name: "CV versions" })).toHaveAttribute(
      "href",
      "/cv-versions",
    );
    expect(screen.getByRole("link", { name: "Quotas" })).toHaveAttribute(
      "href",
      "/quotas",
    );
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("lists every Admin section in an Administrator's nav", () => {
    renderWithProviders(<AppSidebar />, { session: ADMIN_SESSION });

    const nav = within(screen.getByRole("navigation"));
    const hrefs = Object.fromEntries(
      nav.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    );
    expect(hrefs).toEqual({
      Dashboard: "/admin",
      Users: "/admin/users",
      Quotas: "/admin/quotas",
      Analyses: "/admin/analyses",
      Scouts: "/admin/scouts",
      "CV versions": "/admin/cv-versions",
      "LLM providers": "/admin/llm-providers",
      Settings: "/settings",
    });
  });

  it("marks the Admin section of the current route active, and only that one", () => {
    pathname = "/admin/scouts";
    renderWithProviders(<AppSidebar />, { session: ADMIN_SESSION });

    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByRole("link", { name: "Scouts" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // /admin prefixes every other section, so its own row only matches exactly.
    expect(nav.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("marks the Admin dashboard active on an exact /admin match", () => {
    pathname = "/admin";
    renderWithProviders(<AppSidebar />, { session: ADMIN_SESSION });

    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("link", { name: "Users" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("hides the Admin sections from a non-Administrator", () => {
    renderWithProviders(<AppSidebar />, {
      session: { ...SESSION, user: { ...SESSION.user, role: "EXTERNAL" } },
    });

    const nav = within(screen.getByRole("navigation"));
    const hrefs = nav.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs.some((href) => href?.startsWith("/admin"))).toBe(false);
  });

  it("hides the Admin sections when the session carries no role", () => {
    renderWithProviders(<AppSidebar />, { session: SESSION });

    const nav = within(screen.getByRole("navigation"));
    const hrefs = nav.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs.some((href) => href?.startsWith("/admin"))).toBe(false);
  });

  it("hides the per-Candidate routes from an Administrator, keeping Settings", () => {
    renderWithProviders(<AppSidebar />, { session: ADMIN_SESSION });

    const nav = within(screen.getByRole("navigation"));
    const hrefs = nav.getAllByRole("link").map((link) => link.getAttribute("href"));
    for (const candidateRoute of [
      "/",
      "/analyses",
      "/scouts",
      "/applications",
      "/cv-versions",
      "/quotas",
    ]) {
      expect(hrefs).not.toContain(candidateRoute);
    }
    expect(hrefs).toContain("/settings");
  });

  it("hides the New analysis primary action from an Administrator", () => {
    renderWithProviders(<AppSidebar />, { session: ADMIN_SESSION });

    expect(
      screen.queryByRole("link", { name: "New analysis" }),
    ).not.toBeInTheDocument();
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

  it("marks Settings active on the /settings route", () => {
    pathname = "/settings";
    renderWithProviders(<AppSidebar />, { session: SESSION });

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
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

    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
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

  it("names the current Admin section for an Administrator", () => {
    pathname = "/admin/cv-versions";
    renderWithProviders(<AppTopbar />, { session: ADMIN_SESSION });

    expect(
      screen.getByRole("heading", { name: "CV versions" }),
    ).toBeInTheDocument();
  });

  it("never names an Admin route for a non-Administrator", () => {
    pathname = "/admin/users";
    renderWithProviders(<AppTopbar />, { session: SESSION });

    expect(
      screen.getByRole("heading", { name: "Job Hunt Crew" }),
    ).toBeInTheDocument();
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

  it("exposes an account menu that signs out, independent of the drawer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppTopbar />, { session: SESSION });

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });
});
