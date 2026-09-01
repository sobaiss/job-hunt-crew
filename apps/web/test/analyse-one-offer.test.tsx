import { describe, expect, it, vi } from "vitest";
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
};

function stubApi(options: StubOptions = {}) {
  const {
    cvVersions = [cv()],
    onCreate,
    jobStatus = "RUNNING",
    jobErrorMessage = null,
    analyses = [],
  } = options;
  let creates = 0;

  server.use(
    http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions })),
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

  return { creates: () => creates };
}

describe("AnalyseOneOfferPage", () => {
  it("preselects the default CONVERTED CV and enables submit", async () => {
    stubApi();
    renderWithProviders(<AnalyseOneOfferPage />);

    const select = await screen.findByLabelText("CV version");
    await waitFor(() => expect(select).toHaveValue("cv-default"));
    expect(
      screen.getByRole("button", { name: "Analyse this offer" }),
    ).toBeEnabled();
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

  it("rejects an empty URL", async () => {
    stubApi();
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
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

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
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

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
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

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
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

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
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

    await waitFor(() =>
      expect(screen.getByLabelText("CV version")).toHaveValue("cv-default"),
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
});

const CV_UPLOAD_URL = "https://uploads.example.test/cv";

type ImportStubOptions = {
  conversionStatus?: string;
  onCreateCv?: (body: Record<string, unknown>) => void;
};

/**
 * Stubs the inline-CV-import path: the CV list is empty until the presigned PUT
 * lands, then it returns one freshly imported CV whose `conversionStatus` is
 * `conversionStatus` (so a test can pin it to CONVERTING / FAILED / CONVERTED).
 */
function stubImportApi(options: ImportStubOptions = {}) {
  const { conversionStatus = "CONVERTED", onCreateCv } = options;
  let uploaded = false;

  server.use(
    http.get("/api/cv-versions", () =>
      HttpResponse.json({
        cvVersions: uploaded
          ? [
              cv({
                id: "cv-new",
                label: "Fresh CV",
                isDefault: false,
                conversionStatus,
              }),
            ]
          : [],
      }),
    ),
    http.post("/api/cv-versions", async ({ request }) => {
      onCreateCv?.((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        { cvVersionId: "cv-new", fileKey: "k", uploadUrl: CV_UPLOAD_URL },
        { status: 201 },
      );
    }),
    http.put(CV_UPLOAD_URL, () => {
      uploaded = true;
      return new HttpResponse(null, { status: 200 });
    }),
    http.post("/api/ingestion-jobs", () =>
      HttpResponse.json(
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
      ),
    ),
    http.get("/api/analyses", () => HttpResponse.json({ analyses: [] })),
  );
}

function freshCvFile() {
  return new File(["%PDF-1.4"], "fresh-cv.pdf", { type: "application/pdf" });
}

describe("AnalyseOneOfferPage — inline CV import", () => {
  it("imports a CV inline and enables submit once it is CONVERTED", async () => {
    let createBody: Record<string, unknown> | null = null;
    stubImportApi({ onCreateCv: (b) => (createBody = b) });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await screen.findByLabelText("New CV label");
    const submit = screen.getByRole("button", { name: "Analyse this offer" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("New CV label"), "Fresh CV");
    await user.upload(screen.getByLabelText("New CV file"), freshCvFile());
    await user.click(screen.getByRole("button", { name: "Import CV" }));

    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.getByLabelText("CV version")).toHaveValue("cv-new");
    expect(createBody).toMatchObject({
      fileName: "fresh-cv.pdf",
      contentType: "application/pdf",
    });
  });

  it("shows a converting state and keeps submit disabled while conversion is pending", async () => {
    stubImportApi({ conversionStatus: "CONVERTING" });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await screen.findByLabelText("New CV label");
    await user.type(screen.getByLabelText("New CV label"), "Fresh CV");
    await user.upload(screen.getByLabelText("New CV file"), freshCvFile());
    await user.click(screen.getByRole("button", { name: "Import CV" }));

    expect(
      await screen.findByText(
        "Converting your CV — this usually takes a few seconds.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Analyse this offer" }),
    ).toBeDisabled();
  });

  it("shows an error and keeps submit disabled when the conversion fails", async () => {
    stubImportApi({ conversionStatus: "FAILED" });
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await screen.findByLabelText("New CV label");
    await user.type(screen.getByLabelText("New CV label"), "Fresh CV");
    await user.upload(screen.getByLabelText("New CV file"), freshCvFile());
    await user.click(screen.getByRole("button", { name: "Import CV" }));

    expect(
      await screen.findByText(
        "We couldn't convert that CV. Try a different file.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Analyse this offer" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("CV version")).toHaveValue("");
  });

  it("keeps the typed offer URL while a CV is imported and converted", async () => {
    stubImportApi();
    const user = userEvent.setup();
    renderWithProviders(<AnalyseOneOfferPage />);

    await screen.findByLabelText("New CV label");
    await user.type(
      screen.getByLabelText("Job offer URL"),
      "https://jobs.example.com/staff-engineer",
    );
    await user.type(screen.getByLabelText("New CV label"), "Fresh CV");
    await user.upload(screen.getByLabelText("New CV file"), freshCvFile());
    await user.click(screen.getByRole("button", { name: "Import CV" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Analyse this offer" }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText("Job offer URL")).toHaveValue(
      "https://jobs.example.com/staff-engineer",
    );
  });
});
