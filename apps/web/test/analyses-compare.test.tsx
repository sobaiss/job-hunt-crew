import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import CompareAnalysesPage from "@/app/(app)/analyses/compare/[jobOfferId]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ jobOfferId: "job1" }),
}));

const RESULT = {
  match_score: 87,
  matched_skills: [{ skill: "TypeScript", evidence: "5 years at Acme" }],
  missing_skills: [{ skill: "Kubernetes", importance: "required" as const }],
  strengths: ["Ships fast"],
  weaknesses: ["Thin on infra"],
  improvement_suggestions: [
    { area: "Infra", suggestion: "Add a k8s project", priority: "high" as const },
  ],
  summary: "Strong product engineer, light on platform work.",
};

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 87,
    requestedAt: "2026-08-01T00:00:00.000Z",
    jobOffer: { id: "job1", title: "Backend Engineer", company: "Acme Inc" },
    cvVersion: { label: "Grad CV" },
    resultJSON: RESULT,
    errorMessage: null,
    ...overrides,
  };
}

describe("CompareAnalysesPage", () => {
  it("renders one column per analysed CV version, aligned by result category", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            analysis({ id: "a1", cvVersion: { label: "Grad CV" } }),
            analysis({ id: "a2", cvVersion: { label: "Senior CV" } }),
          ],
        }),
      ),
    );

    renderWithProviders(<CompareAnalysesPage />);

    expect(await screen.findByText("Grad CV")).toBeInTheDocument();
    expect(screen.getByText("Senior CV")).toBeInTheDocument();
    // The offer heading is shown once.
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    // Each column renders the shared result view.
    expect(screen.getAllByText("Match score")).toHaveLength(2);
    expect(screen.getAllByText("Matched skills")).toHaveLength(2);
  });

  it("shows the single-CV notice when only one CV version has been analysed", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ analyses: [analysis()] }),
      ),
    );

    renderWithProviders(<CompareAnalysesPage />);

    expect(
      await screen.findByText(/only one cv version has been analysed/i),
    ).toBeInTheDocument();
  });

  it("does not show the single-CV notice once two CV versions are analysed", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            analysis({ id: "a1", cvVersion: { label: "Grad CV" } }),
            analysis({ id: "a2", cvVersion: { label: "Senior CV" } }),
          ],
        }),
      ),
    );

    renderWithProviders(<CompareAnalysesPage />);

    await screen.findByText("Grad CV");
    expect(
      screen.queryByText(/only one cv version has been analysed/i),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state when the offer has no analyses", async () => {
    server.use(
      http.get("/api/analyses", () => HttpResponse.json({ analyses: [] })),
    );

    renderWithProviders(<CompareAnalysesPage />);

    expect(
      await screen.findByText(/no analyses found for this job offer/i),
    ).toBeInTheDocument();
  });

  it("shows an error state when the request fails", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    renderWithProviders(<CompareAnalysesPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load this comparison/i,
    );
  });
});
