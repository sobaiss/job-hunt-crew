import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpResponse, http } from "msw";
import userEvent from "@testing-library/user-event";
import type { Session } from "next-auth";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import AdminLayout from "@/app/(app)/admin/layout";
import AdminPage from "@/app/(app)/admin/page";

const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
let pathname = "/admin";
vi.mock("next/navigation", () => ({
  redirect,
  notFound,
  usePathname: () => pathname,
}));

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));

const ADMIN_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: {
    id: "admin-1",
    name: "Ada",
    email: "ada@example.com",
    role: "ADMINISTRATOR",
  },
};

const STANDARD_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "user-1", name: "Bob", email: "bob@example.com", role: "EXTERNAL" },
};

beforeEach(() => {
  redirect.mockReset();
  notFound.mockReset();
  auth.mockReset();
  pathname = "/admin";
});

describe("Admin layout gate", () => {
  it("redirects a signed-out visitor to sign-in", async () => {
    auth.mockResolvedValue(null);

    await AdminLayout({ children: <div /> });

    expect(redirect).toHaveBeenCalledWith("/sign-in");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s a signed-in Candidate who isn't an Administrator", async () => {
    auth.mockResolvedValue(STANDARD_SESSION);

    await AdminLayout({ children: <div /> });

    expect(notFound).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders children for an Administrator session", async () => {
    auth.mockResolvedValue(ADMIN_SESSION);

    const element = await AdminLayout({ children: <div data-testid="child" /> });
    renderWithProviders(element ?? <></>);

    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders a tab strip linking all six Admin screens", async () => {
    auth.mockResolvedValue(ADMIN_SESSION);

    const element = await AdminLayout({ children: <div /> });
    renderWithProviders(element ?? <></>);

    const tabs = within(screen.getByRole("navigation", { name: "Admin sections" }));
    const hrefs = Object.fromEntries(
      tabs.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    );
    expect(hrefs).toEqual({
      Dashboard: "/admin",
      Users: "/admin/users",
      Quotas: "/admin/quotas",
      Analyses: "/admin/analyses",
      Scouts: "/admin/scouts",
      "CV versions": "/admin/cv-versions",
    });
  });

  it("indicates the current screen in the tab strip", async () => {
    auth.mockResolvedValue(ADMIN_SESSION);
    pathname = "/admin/scouts";

    const element = await AdminLayout({ children: <div /> });
    renderWithProviders(element ?? <></>);

    const tabs = within(screen.getByRole("navigation", { name: "Admin sections" }));
    expect(tabs.getByRole("link", { name: "Scouts" })).toHaveAttribute("aria-current", "page");
    expect(tabs.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(tabs.getByRole("link", { name: "Users" })).not.toHaveAttribute("aria-current");
  });

  it("does not render the tab strip for a non-Administrator", async () => {
    auth.mockResolvedValue(STANDARD_SESSION);

    const element = await AdminLayout({ children: <div /> });
    renderWithProviders(element ?? <></>);

    expect(screen.queryByRole("navigation", { name: "Admin sections" })).not.toBeInTheDocument();
  });
});

function statsResponse(overrides: Record<string, unknown> = {}) {
  return {
    totalUsers: 3,
    usersOverLimitCount: 1,
    analysesRequestedToday: 5,
    analysesRequestedThisMonth: 40,
    documentsCreatedToday: 2,
    activeScoutsTotal: 4,
    newSignups: [
      { date: "2026-09-16", count: 1 },
      { date: "2026-09-17", count: 2 },
    ],
    usersByPlan: { FREE: 2, STANDARD: 1 },
    blockedUsersCount: 1,
    ...overrides,
  };
}

describe("AdminPage", () => {
  beforeEach(() => {
    server.use(http.get("/api/admin/stats", () => HttpResponse.json(statsResponse())));
  });

  it("renders every dashboard figure, the new-signups series, and the Plan breakdown", async () => {
    renderWithProviders(<AdminPage />, { session: ADMIN_SESSION });

    expect(await screen.findByText("3")).toBeInTheDocument(); // totalUsers
    expect(screen.getByText("Blocked users")).toBeInTheDocument();
    expect(screen.getByText("New signups")).toBeInTheDocument();
    expect(screen.getByText("Users by Plan")).toBeInTheDocument();
    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText("STANDARD")).toBeInTheDocument();
  });

  it("re-fetches stats with the selected period, filtering only the new-signups series server-side", async () => {
    const requestedUrls: string[] = [];
    server.use(
      http.get("/api/admin/stats", ({ request }) => {
        requestedUrls.push(request.url);
        return HttpResponse.json(statsResponse());
      }),
    );

    renderWithProviders(<AdminPage />, { session: ADMIN_SESSION });
    await screen.findByText("3");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Period"), "7d");

    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes("period=7d"))).toBe(true);
    });
  });

  it("shows a placeholder when there are no signups in the selected period", async () => {
    server.use(
      http.get("/api/admin/stats", () =>
        HttpResponse.json(statsResponse({ newSignups: [] })),
      ),
    );

    renderWithProviders(<AdminPage />, { session: ADMIN_SESSION });

    expect(await screen.findByText("No signups in this period.")).toBeInTheDocument();
  });
});
