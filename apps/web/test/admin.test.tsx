import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpResponse, http } from "msw";
import type { Session } from "next-auth";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import AdminLayout from "@/app/(app)/admin/layout";
import AdminPage from "@/app/(app)/admin/page";

const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect, notFound }));

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));

const ADMIN_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "admin-1", name: "Ada", email: "ada@example.com", plan: "PREMIUM", isAdmin: true },
};

const STANDARD_SESSION: Session = {
  expires: "2999-01-01T00:00:00.000Z",
  user: { id: "user-1", name: "Bob", email: "bob@example.com", plan: "STANDARD", isAdmin: false },
};

beforeEach(() => {
  redirect.mockReset();
  notFound.mockReset();
  auth.mockReset();
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

  it("renders children for an isAdmin session", async () => {
    auth.mockResolvedValue(ADMIN_SESSION);

    const element = await AdminLayout({ children: <div data-testid="child" /> });
    renderWithProviders(element ?? <></>);

    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});

describe("AdminPage", () => {
  it("confirms admin access via GET /api/admin/me", async () => {
    renderWithProviders(<AdminPage />, { session: ADMIN_SESSION });

    expect(
      await screen.findByText("Signed in as admin-1 (PREMIUM)"),
    ).toBeInTheDocument();
  });

  it("shows an error state when the admin check fails", async () => {
    server.use(
      http.get("/api/admin/me", () => HttpResponse.json({ error: "Forbidden" }, { status: 403 })),
    );

    renderWithProviders(<AdminPage />, { session: ADMIN_SESSION });

    expect(await screen.findByText("Couldn't confirm admin access.")).toBeInTheDocument();
  });
});
