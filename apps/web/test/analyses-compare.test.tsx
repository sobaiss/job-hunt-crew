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
  it("renders a comparison table with one column per analysed CV version, categories aligned in rows", async () => {
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

    expect(await screen.findByRole("table")).toBeInTheDocument();
    // One header cell per CV version.
    expect(screen.getByText("Grad CV")).toBeInTheDocument();
    expect(screen.getByText("Senior CV")).toBeInTheDocument();
    // The offer heading is shown once, above the table.
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    // Category labels are row headers, shown once each.
    expect(screen.getAllByText("Matched skills")).toHaveLength(1);
    expect(screen.getAllByText("Missing skills")).toHaveLength(1);
    expect(screen.getAllByText("Summary")).toHaveLength(1);
    // Each column fills that category's cell.
    expect(screen.getAllByText("TypeScript")).toHaveLength(2);
    expect(screen.getAllByText("Kubernetes")).toHaveLength(2);
  });

  it("gives each CV column header its own match-score gauge and band pill", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            analysis({ id: "a1", cvVersion: { label: "Grad CV" } }),
            analysis({
              id: "a2",
              cvVersion: { label: "Junior CV" },
              resultJSON: { ...RESULT, match_score: 40 },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<CompareAnalysesPage />);

    expect(
      await screen.findByRole("img", { name: "Match score 87 out of 100" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Match score 40 out of 100" }),
    ).toBeInTheDocument();
    // Bands follow the shared helper: 87 -> strong, 40 -> weak (never coral).
    expect(screen.getByText("Strong")).toBeInTheDocument();
    expect(screen.getByText("Weak")).toBeInTheDocument();
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

  it("still shows the single-CV notice when the same CV version was analysed twice", async () => {
    server.use(
      http.get("/api/analyses", () =>
        HttpResponse.json({
          analyses: [
            analysis({
              id: "old",
              cvVersion: { label: "Grad CV" },
              requestedAt: "2026-08-01T00:00:00.000Z",
            }),
            analysis({
              id: "new",
              cvVersion: { label: "Grad CV" },
              requestedAt: "2026-08-05T00:00:00.000Z",
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<CompareAnalysesPage />);

    expect(
      await screen.findByText(/only one cv version has been analysed/i),
    ).toBeInTheDocument();
    // The two rows collapse to a single column.
    expect(screen.getAllByText("Grad CV")).toHaveLength(1);
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
