import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";
import { delay, http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { LandingPage } from "@/components/landing-page";
import { AppShell } from "@/components/app-shell";
import LandingRoute from "@/app/(public)/page";
import { server } from "./msw/server";

// The route calls services/api directly (server-side, no BFF route), so MSW
// intercepts that upstream URL rather than an /api/* path.
const PLANS_URL = `${process.env.API_BASE_URL || "http://localhost:8000"}/v1/plans`;

const PLANS_RESPONSE = {
  plans: [
    {
      plan: "free",
      quotas: {
        ACTIVE_SCOUTS: 2,
        ANALYSES_DAILY: 15,
        ANALYSES_MONTHLY: 300,
        DOCUMENTS_DAILY: 5,
      },
    },
    {
      plan: "standard",
      quotas: {
        ACTIVE_SCOUTS: 6,
        ANALYSES_DAILY: 51,
        ANALYSES_MONTHLY: 1001,
        DOCUMENTS_DAILY: 21,
      },
    },
    {
      plan: "premium",
      quotas: {
        ACTIVE_SCOUTS: 16,
        ANALYSES_DAILY: 151,
        ANALYSES_MONTHLY: 3001,
        DOCUMENTS_DAILY: null,
      },
    },
  ],
};

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
// `redirect` backs the auth-gate tests below; `useRouter` is needed too now
// that the header's LocaleSwitch (rendered as part of LandingPage) calls it.
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));

beforeEach(() => {
  redirect.mockReset();
  auth.mockReset();
  server.use(http.get(PLANS_URL, () => HttpResponse.json(PLANS_RESPONSE)));
});

describe("LandingPage (marketing content)", () => {
  it("leads with the product statement and a primary sign-in call to action", () => {
    renderWithProviders(<LandingPage plans={null} />);

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
    renderWithProviders(<LandingPage plans={null} />);

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
    renderWithProviders(<LandingPage plans={null} />);

    expect(
      screen.getByRole("heading", { name: "More than a single number" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Evidence for every match")).toBeInTheDocument();
    expect(screen.getByText("Prioritised suggestions")).toBeInTheDocument();
  });

  it("shows a product preview of the dashboard", () => {
    renderWithProviders(<LandingPage plans={null} />);

    expect(
      screen.getByRole("heading", {
        name: "A dashboard built around your search",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Preview of the signed-in dashboard"),
    ).toBeInTheDocument();

    // A real Dashboard screenshot, not the old stylised in-page mock.
    const preview = screen.getByRole("img", {
      name: "Preview of the signed-in dashboard",
    });
    expect(preview).toHaveAttribute(
      "src",
      expect.stringContaining("dashboard-preview"),
    );
  });

  it("states that data is isolated per account", () => {
    renderWithProviders(<LandingPage plans={null} />);

    expect(
      screen.getByRole("heading", { name: "Your data stays yours" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/scoped to your account/i),
    ).toBeInTheDocument();
  });

  it("shows an FAQ covering formats, sources, limits, privacy, and the AI model", () => {
    renderWithProviders(<LandingPage plans={null} />);

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
    renderWithProviders(<LandingPage plans={null} />);

    expect(
      screen.getByText(/daily analysis limit: number to be confirmed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/legal links \(privacy, terms\) to be added/i),
    ).toBeInTheDocument();
  });

  it("has a footer", () => {
    renderWithProviders(<LandingPage plans={null} />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("has no pricing, testimonials, or client-logo sections", () => {
    renderWithProviders(<LandingPage plans={null} />);
    expect(screen.queryByText(/pricing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/testimonial/i)).not.toBeInTheDocument();
  });
});

async function renderSignedOutRoute(locale: "en" | "fr" = "en") {
  auth.mockResolvedValue(null);
  const element = await LandingRoute();
  return renderWithProviders(element ?? <></>, { locale });
}

function plansSection() {
  const section = document.getElementById("plans");
  expect(section).not.toBeNull();
  return within(section as HTMLElement);
}

function planCard(name: string) {
  const card = plansSection()
    .getByRole("heading", { level: 3, name })
    .closest("li");
  expect(card).not.toBeNull();
  return within(card as HTMLElement);
}

/** The value shown next to a quota label in a plan card (dt → dd). */
function quotaValue(card: ReturnType<typeof planCard>, label: string) {
  return card.getByText(label).nextElementSibling?.textContent;
}

describe("Landing route (Plans section, issue #247)", () => {
  it("shows the three plans with the live quotas read from the API", async () => {
    await renderSignedOutRoute();

    const section = plansSection();
    expect(
      section.getByRole("heading", {
        level: 2,
        name: "Start for free, scale up when you need to",
      }),
    ).toBeInTheDocument();

    const free = planCard("Free");
    expect(free.getByText("To get started")).toBeInTheDocument();
    expect(quotaValue(free, "Active agents")).toBe("2");
    expect(quotaValue(free, "Analyses per day")).toBe("15");
    expect(quotaValue(free, "Analyses per month")).toBe("300");
    expect(quotaValue(free, "Documents generated per day")).toBe("5");

    const standard = planCard("Standard");
    expect(quotaValue(standard, "Active agents")).toBe("6");
    expect(quotaValue(standard, "Analyses per month")).toBe("1001");

    const premium = planCard("Premium");
    expect(quotaValue(premium, "Analyses per day")).toBe("151");
  });

  it("shows Unlimited for a null quota", async () => {
    await renderSignedOutRoute();

    expect(quotaValue(planCard("Premium"), "Documents generated per day")).toBe(
      "Unlimited",
    );
  });

  it("offers Start for free on every card and says paid plans are granted on request", async () => {
    await renderSignedOutRoute();

    for (const name of ["Free", "Standard", "Premium"]) {
      expect(
        planCard(name).getByRole("link", { name: "Start for free" }),
      ).toHaveAttribute("href", "/sign-in");
    }
    expect(
      plansSection().getByText(
        "Standard and Premium are granted on request once you've signed up. No online payment for now.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the French copy with the same quotas", async () => {
    await renderSignedOutRoute("fr");

    const free = planCard("Free");
    expect(free.getByText("Pour découvrir")).toBeInTheDocument();
    expect(quotaValue(free, "Agents actifs")).toBe("2");
    expect(quotaValue(planCard("Premium"), "Documents générés par jour")).toBe(
      "Illimité",
    );
  });

  it("falls back to the three cards without any figure when the API errors", async () => {
    server.use(
      http.get(PLANS_URL, () => new HttpResponse(null, { status: 500 })),
    );
    await renderSignedOutRoute();

    expectFallback();
  });

  it("falls back when the API does not answer within 2 seconds", async () => {
    server.use(
      http.get(PLANS_URL, async () => {
        await delay("infinite");
        return HttpResponse.json(PLANS_RESPONSE);
      }),
    );
    auth.mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let element: Awaited<ReturnType<typeof LandingRoute>>;
    try {
      const pending = LandingRoute();
      await vi.advanceTimersByTimeAsync(2000);
      element = await pending;
    } finally {
      vi.useRealTimers();
    }
    renderWithProviders(element ?? <></>);

    expectFallback();
  });
});

function expectFallback() {
  const section = plansSection();
  expect(
    section.getByRole("heading", { level: 3, name: "Free" }),
  ).toBeInTheDocument();
  expect(section.getByText("For an active search")).toBeInTheDocument();
  expect(section.getByText("For an intensive search")).toBeInTheDocument();
  expect(section.queryByText("Active agents")).not.toBeInTheDocument();
  expect(section.queryByText("Unlimited")).not.toBeInTheDocument();
  // No figure at all in the cards — never a hard-coded fallback number.
  for (const card of section.getAllByRole("listitem")) {
    expect(card.textContent).not.toMatch(/\d/);
  }
}

describe("Landing route (auth gate)", () => {
  it("serves the Dashboard inside the App shell to a signed-in visitor, not the marketing page", async () => {
    const session: Session = {
      expires: "2999-01-01T00:00:00.000Z",
      user: { id: "u1", name: "Ada", email: "ada@example.com" },
    };
    auth.mockResolvedValue(session);

    const element = await LandingRoute();

    expect(redirect).not.toHaveBeenCalled();
    expect(element?.type).toBe(AppShell);
  });

  it("renders the marketing page for a signed-out visitor", async () => {
    auth.mockResolvedValue(null);

    const element = await LandingRoute();
    renderWithProviders(element ?? <></>);

    expect(redirect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /match your cv against real job offers/i,
      }),
    ).toBeInTheDocument();
  });

  it("redirects an Administrator to the Admin dashboard instead of the Candidate Dashboard", async () => {
    const session: Session = {
      expires: "2999-01-01T00:00:00.000Z",
      user: {
        id: "admin-1",
        name: "Grace",
        email: "grace@example.com",
        role: "ADMINISTRATOR",
      },
    };
    auth.mockResolvedValue(session);

    await LandingRoute();

    expect(redirect).toHaveBeenCalledWith("/admin");
  });
});
