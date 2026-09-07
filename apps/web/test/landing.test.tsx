import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

import { renderWithProviders, screen, within } from "./test-utils";
import { LandingPage } from "@/components/landing-page";
import { AppShell } from "@/components/app-shell";
import LandingRoute from "@/app/(public)/page";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));

beforeEach(() => {
  redirect.mockReset();
  auth.mockReset();
});

describe("LandingPage (marketing content)", () => {
  it("leads with the product statement and a primary sign-in call to action", () => {
    renderWithProviders(<LandingPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /match your cv against real job offers/i,
      }),
    ).toBeInTheDocument();

    const ctas = screen
      .getAllByRole("link", { name: "Sign in" })
      .filter((el) => el.getAttribute("href") === "/sign-in");
    expect(ctas.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the how-it-works walkthrough with all three steps", () => {
    renderWithProviders(<LandingPage />);

    const section = screen
      .getByRole("heading", { name: "How it works" })
      .closest("section");
    expect(section).not.toBeNull();
    const region = within(section as HTMLElement);
    expect(region.getByText("Add a job offer")).toBeInTheDocument();
    expect(region.getByText("Choose a CV")).toBeInTheDocument();
    expect(region.getByText("Read the analysis")).toBeInTheDocument();
  });

  it("shows a features section written around what you get beyond a score", () => {
    renderWithProviders(<LandingPage />);

    expect(
      screen.getByRole("heading", { name: "More than a single number" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Evidence for every match")).toBeInTheDocument();
    expect(screen.getByText("Prioritised suggestions")).toBeInTheDocument();
  });

  it("shows a product preview of the dashboard", () => {
    renderWithProviders(<LandingPage />);

    expect(
      screen.getByRole("heading", {
        name: "A dashboard built around your search",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Preview of the signed-in dashboard"),
    ).toBeInTheDocument();
  });

  it("states that data is isolated per account", () => {
    renderWithProviders(<LandingPage />);

    expect(
      screen.getByRole("heading", { name: "Your data stays yours" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/scoped to your account/i),
    ).toBeInTheDocument();
  });

  it("shows an FAQ covering formats, sources, limits, privacy, and the AI model", () => {
    renderWithProviders(<LandingPage />);

    const section = screen
      .getByRole("heading", { name: "Frequently asked questions" })
      .closest("section");
    const region = within(section as HTMLElement);
    expect(
      region.getByText("What CV formats can I upload?"),
    ).toBeInTheDocument();
    expect(
      region.getByText("Which job sites are supported?"),
    ).toBeInTheDocument();
    expect(
      region.getByText("Is there a limit on how many analyses I can run?"),
    ).toBeInTheDocument();
    expect(
      region.getByText("Who can see my CVs and analyses?"),
    ).toBeInTheDocument();
    expect(
      region.getByText("What AI model does the analysis use?"),
    ).toBeInTheDocument();
  });

  it("renders visible placeholder markers for the daily cap and legal links, not fabricated values", () => {
    renderWithProviders(<LandingPage />);

    expect(
      screen.getByText(/daily analysis limit: number to be confirmed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/legal links \(privacy, terms\) to be added/i),
    ).toBeInTheDocument();
  });

  it("has a footer", () => {
    renderWithProviders(<LandingPage />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("has no pricing, testimonials, or client-logo sections", () => {
    renderWithProviders(<LandingPage />);
    expect(screen.queryByText(/pricing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/testimonial/i)).not.toBeInTheDocument();
  });
});

describe("Landing route (auth gate)", () => {
  it("serves the Dashboard inside the App shell to a signed-in visitor, not the marketing page", async () => {
    const session: Session = {
      expires: "2999-01-01T00:00:00.000Z",
      user: { id: "u1", name: "Ada", email: "ada@example.com" },
    };
    auth.mockResolvedValue(session);

    const element = await LandingRoute();

    expect(redirect).not.toHaveBeenCalled();
    expect(element.type).toBe(AppShell);
  });

  it("renders the marketing page for a signed-out visitor", async () => {
    auth.mockResolvedValue(null);

    const element = await LandingRoute();
    renderWithProviders(element);

    expect(redirect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /match your cv against real job offers/i,
      }),
    ).toBeInTheDocument();
  });
});
