import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminCvVersionsPage from "@/app/(app)/admin/cv-versions/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return mock;
});

function cvVersionsListResponse(overrides: Record<string, unknown> = {}) {
  return {
    cvVersions: [
      {
        id: "cv-1",
        userId: "user-1",
        userName: "Ada Lovelace",
        userEmail: "user1@example.com",
        label: "CV principal",
        fileName: "cv.pdf",
        fileType: "PDF",
        isDefault: true,
        conversionStatus: "CONVERTED",
        conversionError: null,
        supersededById: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
    ...overrides,
  };
}

describe("AdminCvVersionsPage", () => {
  beforeEach(() => {
    __setUrl("/admin/cv-versions");
  });

  afterEach(() => {
    __setUrl("/admin/cv-versions");
  });

  it("renders the CV versions table", async () => {
    server.use(
      http.get("/api/admin/cv-versions", () => HttpResponse.json(cvVersionsListResponse())),
    );

    renderWithProviders(<AdminCvVersionsPage />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("cv.pdf")).toBeInTheDocument();
  });

  it("shows \"Yes\" in the Superseded column for a superseded row", async () => {
    server.use(
      http.get("/api/admin/cv-versions", () =>
        HttpResponse.json(
          cvVersionsListResponse({
            cvVersions: [
              { ...cvVersionsListResponse().cvVersions[0], id: "cv-2", supersededById: "cv-1" },
            ],
          }),
        ),
      ),
    );

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");

    const supersededColumn = screen.getByRole("columnheader", { name: "Superseded" });
    const supersededColumnIndex = Array.from(supersededColumn.parentElement!.children).indexOf(
      supersededColumn,
    );
    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    const cell = row.querySelectorAll("td")[supersededColumnIndex];
    expect(cell).toHaveTextContent("Yes");
  });

  it("omits includeSuperseded from the request by default, and sends it once the checkbox is checked", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/cv-versions", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(cvVersionsListResponse());
      }),
    );

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");
    expect(capturedUrl).not.toContain("includeSuperseded");

    await userEvent.click(screen.getByRole("checkbox", { name: "Show superseded versions" }));
    await waitFor(() => expect(capturedUrl).toContain("includeSuperseded=true"));

    await userEvent.click(screen.getByRole("checkbox", { name: "Show superseded versions" }));
    await waitFor(() => expect(capturedUrl).not.toContain("includeSuperseded"));
  });

  it("hides the Reconvert action for superseded rows", async () => {
    server.use(
      http.get("/api/admin/cv-versions", () =>
        HttpResponse.json(
          cvVersionsListResponse({
            cvVersions: [
              { ...cvVersionsListResponse().cvVersions[0], id: "cv-2", supersededById: "cv-1" },
            ],
          }),
        ),
      ),
    );

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: "Reconvert" })).not.toBeInTheDocument();
  });

  it("sends candidate, date-range, and status filters as server-side query params", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/cv-versions", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(cvVersionsListResponse());
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

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.type(screen.getByLabelText("Candidate"), "Ada");
    await userEvent.click(await screen.findByRole("option", { name: /Ada Lovelace/ }));

    const fromInput = screen.getByLabelText("Created from");
    await userEvent.type(fromInput, "2026-01-01");
    const toInput = screen.getByLabelText("Created to");
    await userEvent.type(toInput, "2026-01-31");

    await userEvent.selectOptions(
      screen.getByLabelText("Conversion status"),
      "CONVERTED",
    );

    expect(capturedUrl).toContain("userId=user-1");
    expect(capturedUrl).toContain("createdAtFrom=2026-01-01");
    expect(capturedUrl).toContain("createdAtTo=2026-01-31");
    expect(capturedUrl).toContain("conversionStatus=CONVERTED");
  });

  it("triggers reconversion from the row action", async () => {
    let reconvertCalled = false;
    server.use(
      http.get("/api/admin/cv-versions", () => HttpResponse.json(cvVersionsListResponse())),
      http.post("/api/admin/cv-versions/cv-1/reconvert", () => {
        reconvertCalled = true;
        return HttpResponse.json({ cvVersionId: "cv-1", conversionStatus: "PENDING" });
      }),
    );

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Reconvert" }));

    expect(reconvertCalled).toBe(true);
  });

  it("shows only the Reconvert action — no Set default, Import, or Replace control", async () => {
    server.use(
      http.get("/api/admin/cv-versions", () => HttpResponse.json(cvVersionsListResponse())),
    );

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.getByRole("button", { name: "Reconvert" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set default/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /import/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /replace/i })).not.toBeInTheDocument();
  });

  it("hides the id column by default, showing it with a copy button once toggled on from the Columns menu", async () => {
    server.use(
      http.get("/api/admin/cv-versions", () => HttpResponse.json(cvVersionsListResponse())),
    );

    renderWithProviders(<AdminCvVersionsPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByText("cv-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "ID" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "ID" }),
    ).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "ID" }));
    await userEvent.keyboard("{Escape}");

    expect(screen.getByText("cv-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
  });

  it("shows an empty state when no CV versions match the filters", async () => {
    server.use(
      http.get("/api/admin/cv-versions", () =>
        HttpResponse.json(cvVersionsListResponse({ cvVersions: [], total: 0 })),
      ),
    );

    renderWithProviders(<AdminCvVersionsPage />);

    expect(await screen.findByText("No CV versions yet.")).toBeInTheDocument();
  });
});
