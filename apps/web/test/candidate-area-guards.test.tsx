import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

import { renderWithProviders, screen } from "./test-utils";
import AnalysesLayout from "@/app/(app)/analyses/layout";
import ScoutsLayout from "@/app/(app)/scouts/layout";
import CvVersionsLayout from "@/app/(app)/cv-versions/layout";
import QuotasLayout from "@/app/(app)/quotas/layout";
import ApplicationsLayout from "@/app/(app)/applications/layout";

const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect, notFound }));

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
});

describe.each([
  { name: "Analyses", Layout: AnalysesLayout, adminHref: "/admin/analyses" },
  { name: "Scouts", Layout: ScoutsLayout, adminHref: "/admin/scouts" },
  { name: "CV versions", Layout: CvVersionsLayout, adminHref: "/admin/cv-versions" },
  { name: "Quotas", Layout: QuotasLayout, adminHref: "/admin/quotas" },
])("$name layout gate", ({ Layout, adminHref }) => {
  it(`redirects an Administrator to ${adminHref}`, async () => {
    auth.mockResolvedValue(ADMIN_SESSION);

    await Layout({ children: <div /> });

    expect(redirect).toHaveBeenCalledWith(adminHref);
  });

  it("renders children for a non-Administrator", async () => {
    auth.mockResolvedValue(STANDARD_SESSION);

    const element = await Layout({ children: <div data-testid="child" /> });
    renderWithProviders(element ?? <></>);

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders children for a signed-out visitor (this gate only checks Role)", async () => {
    auth.mockResolvedValue(null);

    const element = await Layout({ children: <div data-testid="child" /> });
    renderWithProviders(element ?? <></>);

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});

// Unlike the four gates above, Applications has no Admin-area equivalent to
// redirect an Administrator to, so a direct visit 404s instead (mirroring
// how app/(app)/admin/layout.tsx 404s a non-Administrator).
describe("Applications layout gate", () => {
  it("404s an Administrator", async () => {
    auth.mockResolvedValue(ADMIN_SESSION);

    await ApplicationsLayout({ children: <div /> });

    expect(notFound).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders children for a non-Administrator", async () => {
    auth.mockResolvedValue(STANDARD_SESSION);

    const element = await ApplicationsLayout({ children: <div data-testid="child" /> });
    renderWithProviders(element ?? <></>);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders children for a signed-out visitor (this gate only checks Role)", async () => {
    auth.mockResolvedValue(null);

    const element = await ApplicationsLayout({ children: <div data-testid="child" /> });
    renderWithProviders(element ?? <></>);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
