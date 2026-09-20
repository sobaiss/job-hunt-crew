import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminAnalysesPage from "@/app/(app)/admin/analyses/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return mock;
});

function analysesListResponse(overrides: Record<string, unknown> = {}) {
  return {
    analyses: [
      {
        id: "analysis-1",
        userId: "user-1",
        userName: "Ada Lovelace",
        userEmail: "user1@example.com",
        jobOfferId: "offer-1",
        jobOfferTitle: "Backend Dev",
        jobOfferCompany: "Acme",
        status: "COMPLETED",
        applicationStatus: null,
        requestedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
    ...overrides,
  };
}

describe("AdminAnalysesPage", () => {
  beforeEach(() => {
    __setUrl("/admin/analyses");
  });

  afterEach(() => {
    __setUrl("/admin/analyses");
  });

  it("renders the analyses table", async () => {
    server.use(
      http.get("/api/admin/analyses", () => HttpResponse.json(analysesListResponse())),
    );

    renderWithProviders(<AdminAnalysesPage />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Backend Dev")).toBeInTheDocument();
  });

  it("sends candidate and date-range filters as server-side query params", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/analyses", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(analysesListResponse());
      }),
      http.get("/api/admin/users", () =>
        HttpResponse.json({
          users: [
            {
              id: "user-1",
              name: "Ada Lovelace",
              email: "user1@example.com",
              plan: "FREE",
              role: "EXTERNAL",
              blocked: false,
              atOrOverLimit: false,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      ),
    );

    renderWithProviders(<AdminAnalysesPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.type(screen.getByLabelText("Candidate"), "Ada");
    await userEvent.click(await screen.findByRole("option", { name: /Ada Lovelace/ }));

    const fromInput = screen.getByLabelText("Requested from");
    await userEvent.type(fromInput, "2026-01-01");
    const toInput = screen.getByLabelText("Requested to");
    await userEvent.type(toInput, "2026-01-31");

    expect(capturedUrl).toContain("userId=user-1");
    expect(capturedUrl).toContain("requestedAtFrom=2026-01-01");
    expect(capturedUrl).toContain("requestedAtTo=2026-01-31");
  });

  it("sends the status filter as a server-side query param (#172)", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/analyses", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(analysesListResponse());
      }),
    );

    renderWithProviders(<AdminAnalysesPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.selectOptions(screen.getByLabelText("Status"), "Failed");

    expect(capturedUrl).toContain("status=FAILED");
  });

  it("hides the id column by default, showing it with a copy button once toggled on from the Columns menu", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/admin/analyses", () => HttpResponse.json(analysesListResponse())),
    );

    renderWithProviders(<AdminAnalysesPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByText("analysis-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "ID" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "ID" }),
    ).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "ID" }));
    await user.keyboard("{Escape}");

    expect(screen.getByText("analysis-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
  });

  it("triggers a retry from the row action", async () => {
    let retryCalled = false;
    server.use(
      http.get("/api/admin/analyses", () => HttpResponse.json(analysesListResponse())),
      http.post("/api/admin/analyses/analysis-1/retry", () => {
        retryCalled = true;
        return HttpResponse.json({ analysisId: "analysis-2", status: "PENDING" });
      }),
    );

    renderWithProviders(<AdminAnalysesPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Relancer l'analyse" }));

    expect(retryCalled).toBe(true);
  });

  it("triggers document generation from the row action when the analysis is completed", async () => {
    let generateCalled = false;
    server.use(
      http.get("/api/admin/analyses", () => HttpResponse.json(analysesListResponse())),
      http.post("/api/admin/analyses/analysis-1/generated-documents", () => {
        generateCalled = true;
        return HttpResponse.json({
          generatedDocuments: [
            { id: "doc-1", type: "COVER_LETTER", status: "PENDING" },
            { id: "doc-2", type: "TAILORED_CV", status: "PENDING" },
          ],
        });
      }),
    );

    renderWithProviders(<AdminAnalysesPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Générer les documents" }));

    expect(generateCalled).toBe(true);
  });

  it("shows no status-transition controls anywhere on this page", async () => {
    server.use(
      http.get("/api/admin/analyses", () => HttpResponse.json(analysesListResponse())),
    );

    renderWithProviders(<AdminAnalysesPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.getByRole("button", { name: "Relancer l'analyse" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Générer les documents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /applied/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rejected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accepted/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /withdrawn/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when no analyses match the filters", async () => {
    server.use(
      http.get("/api/admin/analyses", () =>
        HttpResponse.json(analysesListResponse({ analyses: [], total: 0 })),
      ),
    );

    renderWithProviders(<AdminAnalysesPage />);

    expect(await screen.findByText("No analyses yet.")).toBeInTheDocument();
  });
});
