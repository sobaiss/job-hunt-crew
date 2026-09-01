import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import AnalyseSeveralOffersPage from "@/app/(app)/analyses/new/several/page";

function cv(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv-default",
    label: "Default CV",
    fileName: "cv.pdf",
    fileType: "PDF",
    fileSizeBytes: 1234,
    isDefault: true,
    conversionStatus: "CONVERTED",
    conversionError: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function site(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-ft",
    siteKey: "FRANCE_TRAVAIL",
    displayName: "France Travail",
    integrationType: "OFFICIAL_API",
    antiBotRiskLevel: "LOW",
    ...overrides,
  };
}

function analysisRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 50,
    requestedAt: "2026-08-01T00:00:00.000Z",
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme" },
    cvVersion: { label: "Default CV" },
    resultJSON: null,
    errorMessage: null,
    ...overrides,
  };
}

type StubOptions = {
  cvVersions?: ReturnType<typeof cv>[];
  siteConfigs?: ReturnType<typeof site>[];
  onCreate?: (body: Record<string, unknown>) => void;
  jobStatus?: string;
  discoveredCount?: number;
  analyses?: ReturnType<typeof analysisRow>[];
  quota?: { cap: number; used: number; remaining: number };
};

function stubApi(options: StubOptions = {}) {
  const {
    cvVersions = [cv()],
    siteConfigs = [site()],
    onCreate,
    jobStatus = "RUNNING",
    discoveredCount = 0,
    analyses = [],
    quota = { cap: 50, used: 0, remaining: 50 },
  } = options;

  server.use(
    http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions })),
    http.get("/api/site-configs", () => HttpResponse.json({ siteConfigs })),
    http.get("/api/analyses/quota", () => HttpResponse.json({ quota })),
    http.post("/api/ingestion-jobs", async ({ request }) => {
      onCreate?.((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        {
          ingestionJob: {
            id: "j1",
            mode: "SITE_SEARCH",
            status: "PENDING",
            discoveredCount: 0,
            scrapedCount: 0,
            failedCount: 0,
            errorMessage: null,
          },
        },
        { status: 201 },
      );
    }),
    http.get("/api/ingestion-jobs/j1", () =>
      HttpResponse.json({
        ingestionJob: {
          id: "j1",
          mode: "SITE_SEARCH",
          status: jobStatus,
          discoveredCount,
          scrapedCount: 0,
          failedCount: 0,
          errorMessage: null,
          jobOffers: [],
        },
      }),
    ),
    http.get("/api/analyses", () => HttpResponse.json({ analyses })),
  );
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
  );
  await user.selectOptions(screen.getByLabelText("Job site"), "site-ft");
  await user.click(
    screen.getByRole("button", { name: "Analyse these offers" }),
  );
}

describe("AnalyseSeveralOffersPage", () => {
  it("lists every enabled site with a reliability annotation", async () => {
    stubApi({
      siteConfigs: [
        site(),
        site({
          id: "site-li",
          siteKey: "LINKEDIN",
          displayName: "LinkedIn",
          integrationType: "SCRAPING",
          antiBotRiskLevel: "HIGH",
        }),
      ],
    });
    renderWithProviders(<AnalyseSeveralOffersPage />);

    const select = await screen.findByLabelText("Job site");
    expect(
      within(select).getByRole("option", {
        name: /France Travail.*recommended/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole("option", { name: /LinkedIn.*may fail/i }),
    ).toBeInTheDocument();
  });

  it("bounds the offer-count field to 1..25", async () => {
    stubApi();
    renderWithProviders(<AnalyseSeveralOffersPage />);

    const field = await screen.findByLabelText("How many offers to analyse");
    expect(field).toHaveAttribute("min", "1");
    expect(field).toHaveAttribute("max", "25");
  });

  it("shows the pre-submit daily-quota estimate from the current offer count", async () => {
    stubApi({ quota: { cap: 50, used: 45, remaining: 5 } });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseSeveralOffersPage />);

    const field = await screen.findByLabelText("How many offers to analyse");
    expect(
      await screen.findByText("Up to 10 analyses will run — 5 left today."),
    ).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "8");
    expect(
      await screen.findByText("Up to 8 analyses will run — 5 left today."),
    ).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "1");
    expect(
      await screen.findByText("Up to 1 analysis will run — 5 left today."),
    ).toBeInTheDocument();
  });

  it("disables submit and points to CV management when no CV is converted", async () => {
    stubApi({ cvVersions: [cv({ conversionStatus: "PENDING" })] });
    renderWithProviders(<AnalyseSeveralOffersPage />);

    await screen.findByLabelText("Job site");
    expect(
      await screen.findByRole("link", { name: "Import a CV" }),
    ).toHaveAttribute("href", "/cv-versions");
    expect(
      screen.getByRole("button", { name: "Analyse these offers" }),
    ).toBeDisabled();
  });

  it("submits a SITE_SEARCH job carrying the CV, filters and maxOffers", async () => {
    let body: Record<string, unknown> | null = null;
    stubApi({ onCreate: (b) => (body = b) });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseSeveralOffersPage />);

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
    );
    await user.selectOptions(screen.getByLabelText("Job site"), "site-ft");
    await user.type(screen.getByLabelText("Keywords"), "backend");
    await user.clear(screen.getByLabelText("How many offers to analyse"));
    await user.type(screen.getByLabelText("How many offers to analyse"), "5");
    await user.click(
      screen.getByRole("button", { name: "Analyse these offers" }),
    );

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({
      mode: "SITE_SEARCH",
      siteConfigId: "site-ft",
      cvVersionId: "cv-default",
      maxOffers: 5,
      filters: { keywords: "backend" },
    });
  });

  it("shows the batch result view: progress header, ranked rows, row links", async () => {
    stubApi({
      jobStatus: "COMPLETED",
      discoveredCount: 2,
      analyses: [
        analysisRow({ id: "a-low", matchScore: 30 }),
        analysisRow({
          id: "a-high",
          matchScore: 88,
          jobOffer: { id: "job2", title: "Staff Engineer", company: "Globex" },
        }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseSeveralOffersPage />);
    await submit(user);

    expect(await screen.findByText("Offers found")).toBeInTheDocument();
    expect(screen.getByText("Analyses completed")).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: /Engineer/ });
    expect(links[0]).toHaveAttribute("href", "/analyses/a-high");
    expect(links[1]).toHaveAttribute("href", "/analyses/a-low");

    expect(
      screen.getByRole("link", { name: "Scraping progress" }),
    ).toHaveAttribute("href", "/ingestion-jobs/j1");
  });

  it("shows an all-failed message when the run finished with no analyses", async () => {
    stubApi({ jobStatus: "FAILED", discoveredCount: 0, analyses: [] });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseSeveralOffersPage />);
    await submit(user);

    expect(
      await screen.findByText(
        "None of the offers in this run could be fetched or read.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Scraping progress" }),
    ).toHaveAttribute("href", "/ingestion-jobs/j1");
  });
});
