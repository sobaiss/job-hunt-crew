import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import AnalyseOneOfferPage from "@/app/(app)/analyses/new/page";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

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
    supersededById: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function analysisRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "RUNNING_CREW",
    matchScore: null,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv-default",
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme" },
    cvVersion: { label: "Default CV" },
    resultJSON: null,
    errorMessage: null,
    ...overrides,
  };
}

type StubOptions = {
  cvVersions?: ReturnType<typeof cv>[];
  onCreate?: (body: Record<string, unknown>) => void;
  jobStatus?: string;
  jobErrorMessage?: string | null;
  analyses?: ReturnType<typeof analysisRow>[];
  /** What `GET /api/job-offers?url=` resolves to; `null` (default) = unknown URL. */
  knownOffer?: { id: string; extractionStatus: string } | null;
  onCreateAnalysis?: (body: Record<string, unknown>) => void;
  /** Status for `POST /api/analyses` — 202 (default) or 429 for the daily cap. */
  analysisPostStatus?: number;
};

function stubApi(options: StubOptions = {}) {
  const {
    cvVersions = [cv()],
    onCreate,
    jobStatus = "RUNNING",
    jobErrorMessage = null,
    analyses = [],
    knownOffer = null,
    onCreateAnalysis,
    analysisPostStatus = 202,
  } = options;
  let creates = 0;
  let analysisCreates = 0;

  server.use(
    http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions })),
    http.get("/api/job-offers", () =>
      HttpResponse.json({ jobOffer: knownOffer }),
    ),
    http.post("/api/ingestion-jobs", async ({ request }) => {
      creates += 1;
      onCreate?.((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        {
          ingestionJob: {
            id: "j1",
            mode: "SINGLE_URL",
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
    http.post("/api/analyses", async ({ request }) => {
      analysisCreates += 1;
      onCreateAnalysis?.((await request.json()) as Record<string, unknown>);
      if (analysisPostStatus === 429) {
        return HttpResponse.json(
          { error: "Daily analysis limit reached" },
          { status: 429 },
        );
      }
      return HttpResponse.json(
        { analysisId: `a-new-${analysisCreates}` },
        { status: 202 },
      );
    }),
    http.get("/api/ingestion-jobs/j1", () =>
      HttpResponse.json({
        ingestionJob: {
          id: "j1",
          mode: "SINGLE_URL",
          status: jobStatus,
          discoveredCount: 0,
          scrapedCount: 0,
          failedCount: 0,
          errorMessage: jobErrorMessage,
          jobOffers: [],
        },
      }),
    ),
    http.get("/api/analyses", () => HttpResponse.json({ analyses })),
  );

  return {
    creates: () => creates,
    analysisCreates: () => analysisCreates,
  };
}

describe("AnalyseOneOfferPage", () => {
  beforeEach(() => replace.mockClear());

  it("does not preselect the default CV — submit stays disabled until one is chosen", async () => {
    stubApi();
    renderWithProviders(<AnalyseOneOfferPage />);

    const select = await screen.findByLabelText("CV version");
    expect(select).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Analyse this offer" }),
    ).toBeDisabled();
  });

  it("does not let a CV whose conversion has not succeeded be selected", async () => {
    stubApi({
      cvVersions: [
        cv(),
        cv({
          id: "cv-draft",
          label: "Draft CV",
          isDefault: false,
          conversionStatus: "PENDING",
        }),
      ],
    });
    renderWithProviders(<AnalyseOneOfferPage />);

    const select = await screen.findByLabelText("CV version");
    expect(
      within(select).getByRole("option", { name: /Draft CV/ }),
    ).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: /Default CV/ }),
    ).toBeEnabled();
  });

  it("excludes a superseded CV from the picker entirely", async () => {
    stubApi({
      cvVersions: [
        cv({ id: "cv-old", label: "Old CV", isDefault: false, supersededById: "cv-default" }),
        cv(),
      ],
    });
    renderWithProviders(<AnalyseOneOfferPage />);

    const select = await screen.findByLabelText("CV version");
    expect(
      within(select).queryByRole("option", { name: /Old CV/ }),
    ).not.toBeInTheDocument();
    expect(
      within(select).getByRole("option", { name: /Default CV/ }),
    ).toBeInTheDocument();
  });

  it("rejects an empty URL", async () => {
    stubApi();
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.click(
      screen.getByRole("button", { name: "Analyse this offer" }),
    );

    expect(
      await screen.findByText("Paste the URL of the job offer."),
    ).toBeInTheDocument();
  });

  it("creates a SINGLE_URL ingestion job with the pasted URL and chosen CV", async () => {
    let body: Record<string, unknown> | null = null;
    stubApi({ onCreate: (b) => (body = b) });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/backend-engineer",
    );
    await user.click(
      screen.getByRole("button", { name: "Analyse this offer" }),
    );

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      mode: "SINGLE_URL",
      inputUrl: "https://jobs.example.com/backend-engineer",
      cvVersionId: "cv-default",
    });
  });

  it("shows a two-step progress indication while the analysis is pending", async () => {
    stubApi({ jobStatus: "RUNNING", analyses: [] });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/backend-engineer",
    );
    await user.click(
      screen.getByRole("button", { name: "Analyse this offer" }),
    );

    expect(await screen.findByText("Fetching the offer")).toBeInTheDocument();
    expect(screen.getByText("Analysing your match")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("routes to the Analysis detail view once the Analysis exists", async () => {
    stubApi({ analyses: [analysisRow({ id: "a99" })] });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/backend-engineer",
    );
    await user.click(
      screen.getByRole("button", { name: "Analyse this offer" }),
    );

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/analyses/a99"),
    );
  });

  it("shows a plain failure message with a retry action, no technical detail", async () => {
    const stub = stubApi({
      jobStatus: "FAILED",
      jobErrorMessage: "TimeoutError while scraping stage=fetch",
      analyses: [],
    });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/backend-engineer",
    );
    await user.click(
      screen.getByRole("button", { name: "Analyse this offer" }),
    );

    expect(
      await screen.findByText("We couldn't fetch or read that job offer."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/TimeoutError/)).toBeNull();

    expect(stub.creates()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(stub.creates()).toBe(2));
  });

  it("maps a listing-page failure to the redirect message and link, no retry", async () => {
    const stub = stubApi({
      jobStatus: "FAILED",
      jobErrorMessage:
        "LISTING_PAGE_DETECTED: the fetched page looks like a job listing / search-results page, not a single offer",
      analyses: [],
    });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/search?q=backend",
    );
    await user.click(
      screen.getByRole("button", { name: "Analyse this offer" }),
    );

    expect(
      await screen.findByText(
        "That URL looks like a list of offers, not a single job offer.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("We couldn't fetch or read that job offer."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    const link = screen.getByRole("link", { name: "Analyse several offers" });
    expect(link).toHaveAttribute("href", "/analyses/new/several");
    expect(stub.creates()).toBe(1);
  });

  it("takes the direct analyses path for a URL that already resolves to a READY offer", async () => {
    let body: Record<string, unknown> | null = null;
    const stub = stubApi({
      knownOffer: { id: "job-ready", extractionStatus: "READY" },
      analyses: [],
      onCreateAnalysis: (b) => (body = b),
    });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/known-role",
    );
    await user.click(screen.getByRole("button", { name: "Analyse this offer" }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ jobOfferId: "job-ready", cvVersionId: "cv-default" });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/analyses/a-new-1"),
    );
    expect(stub.creates()).toBe(0);
  });

  it("surfaces an existing completed analysis for the same offer + CV with a Re-run action", async () => {
    const stub = stubApi({
      knownOffer: { id: "job-ready", extractionStatus: "READY" },
      analyses: [
        analysisRow({
          id: "a-existing",
          status: "COMPLETED",
          cvVersionId: "cv-default",
        }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/known-role",
    );
    await user.click(screen.getByRole("button", { name: "Analyse this offer" }));

    expect(
      await screen.findByText(
        "You've already analysed this offer with this CV.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View the analysis" }),
    ).toHaveAttribute("href", "/analyses/a-existing");
    expect(replace).not.toHaveBeenCalled();
    expect(stub.analysisCreates()).toBe(0);

    await user.click(screen.getByRole("button", { name: "Re-run" }));

    await waitFor(() => expect(stub.analysisCreates()).toBe(1));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/analyses/a-new-1"),
    );
  });

  it("shows the daily-limit message when POST /api/analyses returns 429", async () => {
    stubApi({
      knownOffer: { id: "job-ready", extractionStatus: "READY" },
      analyses: [],
      analysisPostStatus: 429,
    });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/known-role",
    );
    await user.click(screen.getByRole("button", { name: "Analyse this offer" }));

    expect(
      await screen.findByText(
        "You've reached today's analysis limit. Try again tomorrow.",
      ),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("disables submit and points to CV management when no CV is converted", async () => {
    stubApi({ cvVersions: [cv({ conversionStatus: "PENDING" })] });
    renderWithProviders(<AnalyseOneOfferPage />);

    expect(
      await screen.findByRole("link", { name: "Import a CV" }),
    ).toHaveAttribute("href", "/cv-versions");
    expect(
      screen.getByRole("button", { name: "Analyse this offer" }),
    ).toBeDisabled();
  });
});
