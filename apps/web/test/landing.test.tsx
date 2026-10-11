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
  it("has a footer", () => {
    renderWithProviders(<LandingPage plans={null} />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("has no pricing, testimonials, or client-logo sections", () => {
    renderWithProviders(<LandingPage plans={null} />);
    expect(screen.queryByText(/pricing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/testimonial/i)).not.toBeInTheDocument();
  });

  it("keeps the placeholder markers for the footer's legal and resource links", () => {
    renderWithProviders(<LandingPage plans={null} />);

    expect(
      screen.getByText(/legal links \(privacy, terms\) to be added/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/guide and status links to be added/i),
    ).toBeInTheDocument();
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

function heroSection() {
  const section = screen.getByRole("heading", { level: 1 }).closest("section");
  expect(section).not.toBeNull();
  return within(section as HTMLElement);
}

function finalBanner() {
  const section = screen
    .getByRole("heading", { level: 2, name: "Let your agents search for you." })
    .closest("section");
  expect(section).not.toBeNull();
  return within(section as HTMLElement);
}

describe("Landing route (hero, journey and Start for free, issue #246)", () => {
  it("leads with the agents headline, in English and in French", async () => {
    const { unmount } = await renderSignedOutRoute();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Your agents find the offers. You choose where to apply.",
      }),
    ).toBeInTheDocument();
    unmount();

    await renderSignedOutRoute("fr");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Vos agents cherchent les offres. Vous choisissez où postuler.",
      }),
    ).toBeInTheDocument();
    expect(
      heroSection().getByText(
        "Formule Free incluse à l'inscription. Connexion par e-mail, Google ou LinkedIn.",
      ),
    ).toBeInTheDocument();
  });

  it("points Start for free to /sign-in in the hero and in the final banner", async () => {
    await renderSignedOutRoute();

    expect(
      heroSection().getByRole("link", { name: "Start for free" }),
    ).toHaveAttribute("href", "/sign-in");
    expect(
      heroSection().getByRole("link", { name: "How it works" }),
    ).toHaveAttribute("href", "#how");
    expect(
      finalBanner().getByRole("link", { name: "Start for free" }),
    ).toHaveAttribute("href", "/sign-in");
    expect(
      finalBanner().getByText(
        "Free plan included. Sign in with email, Google, or LinkedIn.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps Sign in only in the header", async () => {
    await renderSignedOutRoute();

    const signIn = screen.getAllByRole("link", { name: "Sign in" });
    expect(signIn).toHaveLength(1);
    expect(signIn[0]).toHaveAttribute("href", "/sign-in");
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Sign in" })).toBe(signIn[0]);
  });

  it("walks through the five steps of the journey", async () => {
    await renderSignedOutRoute();

    const section = document.getElementById("how");
    expect(section).not.toBeNull();
    const region = within(section as HTMLElement);
    expect(
      region.getByRole("heading", {
        level: 2,
        name: "From offer to application, all in one place",
      }),
    ).toBeInTheDocument();
    const steps = region.getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(
      steps.map((step) => within(step).getByRole("heading", { level: 3 }).textContent),
    ).toEqual(["Find", "Analyse", "Tailor", "Apply", "Track"]);
    expect(
      region.getByText(
        "You review, download and apply yourself, on the offer's own site.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an illustrative agent card hidden from assistive technology", async () => {
    await renderSignedOutRoute("fr");

    const title = heroSection().getByText("Agent · Data Engineer — Paris");
    const card = title.closest("[aria-hidden='true']");
    expect(card).not.toBeNull();
    const region = within(card as HTMLElement);
    expect(region.getByText("À jour")).toBeInTheDocument();
    expect(
      region.getByText("Exécuté ce matin · 31 offres analysées · 4 pertinentes"),
    ).toBeInTheDocument();
    expect(region.getByText("Seuil de pertinence : 70")).toBeInTheDocument();
    expect(region.getByText("Senior Data Engineer · Payflow")).toBeInTheDocument();
    expect(region.getByText("Data Engineer Spark · Kessel")).toBeInTheDocument();
    expect(region.getByText("Analytics Engineer · Novable")).toBeInTheDocument();
    expect(
      ["91", "84", "76"].map((score) => region.getByText(score).textContent),
    ).toEqual(["91", "84", "76"]);
  });

  it("no longer has the dashboard preview section", async () => {
    await renderSignedOutRoute();

    expect(
      screen.queryByRole("heading", { name: "A dashboard built around your search" }),
    ).not.toBeInTheDocument();
    for (const img of screen.queryAllByRole("img")) {
      expect(img.getAttribute("src") ?? "").not.toContain("dashboard-preview");
    }
  });

  it("links the header and the footer to #how, #agents, #plans and #faq", async () => {
    await renderSignedOutRoute();

    const expected = [
      ["How it works", "#how"],
      ["Agents", "#agents"],
      ["Plans", "#plans"],
      ["FAQ", "#faq"],
    ];
    for (const landmark of [screen.getByRole("banner"), screen.getByRole("contentinfo")]) {
      const region = within(landmark);
      for (const [name, href] of expected) {
        expect(region.getByRole("link", { name })).toHaveAttribute("href", href);
      }
    }
    expect(
      within(screen.getByRole("contentinfo")).getByText(
        "Agents that search, analyse and prepare your applications.",
      ),
    ).toBeInTheDocument();
  });
});

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

function sectionById(id: string) {
  const section = document.getElementById(id);
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

function privacySection(name: string) {
  const section = screen
    .getByRole("heading", { level: 2, name })
    .closest("section");
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

/** The FAQ questions in order, each with its answer. */
function faqEntries() {
  return Array.from(sectionById("faq").querySelectorAll("details")).map(
    (details) => ({
      q: details.querySelector("summary")?.textContent,
      a: details.querySelector("p")?.textContent,
    }),
  );
}

describe("Landing route (And also, privacy and FAQ, issue #249)", () => {
  it("shows exactly the three And also cards", async () => {
    await renderSignedOutRoute();

    const region = within(sectionById("features"));
    expect(
      region.getByRole("heading", { level: 2, name: "And also" }),
    ).toBeInTheDocument();
    expect(
      region
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "An analysis that shows its reasoning",
      "Several CVs, compared side by side",
      "A one-off search",
    ]);
  });

  it("shows the three And also cards in French", async () => {
    await renderSignedOutRoute("fr");

    const region = within(sectionById("features"));
    expect(
      region.getByRole("heading", { level: 2, name: "Et aussi" }),
    ).toBeInTheDocument();
    expect(
      region
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "Une analyse qui se justifie",
      "Plusieurs CV, comparés côte à côte",
      "Une recherche ponctuelle",
    ]);
  });

  it("leads the privacy section with the CV redaction point", async () => {
    await renderSignedOutRoute();

    const points = within(privacySection("Your data stays yours")).getAllByRole(
      "listitem",
    );
    expect(points).toHaveLength(4);
    expect(points[0]).toHaveTextContent(
      "Your name, contact details, date of birth and nationality are removed from your CV before any AI analysis. They are put back only in the documents generated for you.",
    );
  });

  it("leads the privacy section with the CV redaction point, in French", async () => {
    await renderSignedOutRoute("fr");

    const section = privacySection("Vos données restent les vôtres");
    expect(section).toHaveTextContent(
      "Vos CV, vos analyses, vos documents et vos candidatures sont rattachés à votre compte, et à lui seul.",
    );
    const points = within(section).getAllByRole("listitem");
    expect(points).toHaveLength(4);
    expect(points[0]).toHaveTextContent(
      "Votre nom, vos coordonnées, votre date de naissance et votre nationalité sont retirés de votre CV avant toute analyse par l'IA. Ils ne sont réintégrés que dans les documents générés pour vous.",
    );
  });

  it("asks the eight FAQ questions in order, with their answers", async () => {
    await renderSignedOutRoute();

    const entries = faqEntries();
    expect(entries.map((e) => e.q)).toEqual([
      "What CV formats can I upload?",
      "Which job sites are supported?",
      "How often do the agents run?",
      "Do you apply on my behalf?",
      "Does the AI make up experience?",
      "Do all filters work on every site?",
      "Who can see my CVs and analyses?",
      "How do I move to Standard or Premium?",
    ]);
    for (const { a } of entries) expect(a).toBeTruthy();
    expect(entries[1].a).toBe(
      "Your agents can search France Travail, Welcome to the Jungle, HelloWork and Remotive. You can also paste the URL of an offer published on any site.",
    );
    expect(entries[3].a).toMatch(/^No\./);
    expect(entries[4].a).toMatch(/^No\./);
  });

  it("asks the eight FAQ questions in order, in French", async () => {
    await renderSignedOutRoute("fr");

    const entries = faqEntries();
    expect(entries.map((e) => e.q)).toEqual([
      "Quels formats de CV puis-je importer ?",
      "Quels sites d'emploi sont pris en charge ?",
      "À quelle fréquence tournent les agents ?",
      "Postulez-vous à ma place ?",
      "L'IA invente-t-elle des expériences ?",
      "Tous les filtres fonctionnent-ils sur tous les sites ?",
      "Qui peut voir mes CV et mes analyses ?",
      "Comment passer en Standard ou Premium ?",
    ]);
    expect(entries[7].a).toBe(
      "Inscrivez-vous gratuitement, puis demandez le passage à la formule souhaitée. Les formules Standard et Premium sont attribuées sur demande, sans paiement en ligne pour l'instant.",
    );
  });

  it("has no ⚠ placeholder left in the page body", async () => {
    await renderSignedOutRoute();

    expect(screen.getByRole("main").textContent).not.toContain("⚠");
    expect(screen.getByRole("contentinfo").textContent).toContain("⚠");
  });

  it.each(["en", "fr"] as const)(
    "never cites Scout, Indeed or Glassdoor, and LinkedIn only as a sign-in method (%s)",
    async (locale) => {
      await renderSignedOutRoute(locale);

      // The page's visible text, without next-themes' inline <script>.
      const body = document.body.cloneNode(true) as HTMLElement;
      body.querySelectorAll("script").forEach((el) => el.remove());
      const text = body.textContent ?? "";
      expect(text).not.toMatch(/scout/i);
      expect(text).not.toMatch(/indeed/i);
      expect(text).not.toMatch(/glassdoor/i);
      expect(text).toMatch(/LinkedIn/);

      // Every text naming LinkedIn names it next to Google as a way to sign
      // in — never as a job source.
      const elements = Array.from(document.body.querySelectorAll("*")).filter(
        (el) =>
          Array.from(el.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && /LinkedIn/.test(n.textContent ?? ""),
          ),
      );
      expect(elements.length).toBeGreaterThan(0);
      for (const el of elements) {
        expect(el.textContent).toMatch(/Sign in|Connexion/);
        expect(el.textContent).toMatch(/Google,? (?:or |ou )?LinkedIn/);
      }
    },
  );
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
        name: "Your agents find the offers. You choose where to apply.",
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
