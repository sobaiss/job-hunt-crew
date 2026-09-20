import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminScoutsPage from "@/app/(app)/admin/scouts/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return mock;
});

function scoutsListResponse(overrides: Record<string, unknown> = {}) {
  return {
    scouts: [
      {
        id: "scout-1",
        userId: "user-1",
        userName: "Ada Lovelace",
        userEmail: "user1@example.com",
        label: "Senior Backend — Remote EU",
        status: "ACTIVE",
        matchThreshold: 70,
        lastRunAt: "2026-01-01T00:00:00.000Z",
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

describe("AdminScoutsPage", () => {
  beforeEach(() => {
    __setUrl("/admin/scouts");
  });

  afterEach(() => {
    __setUrl("/admin/scouts");
  });

  it("renders the scouts table", async () => {
    server.use(http.get("/api/admin/scouts", () => HttpResponse.json(scoutsListResponse())));

    renderWithProviders(<AdminScoutsPage />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Senior Backend — Remote EU")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Active")).toBeInTheDocument();
  });

  it("sends candidate, date-range, and status filters as server-side query params", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/scouts", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(scoutsListResponse());
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

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.type(screen.getByLabelText("Candidate"), "Ada");
    await userEvent.click(await screen.findByRole("option", { name: /Ada Lovelace/ }));

    const fromInput = screen.getByLabelText("Last run from");
    await userEvent.type(fromInput, "2026-01-01");
    const toInput = screen.getByLabelText("Last run to");
    await userEvent.type(toInput, "2026-01-31");

    await userEvent.selectOptions(screen.getByLabelText("Status"), "ACTIVE");

    expect(capturedUrl).toContain("userId=user-1");
    expect(capturedUrl).toContain("lastRunAtFrom=2026-01-01");
    expect(capturedUrl).toContain("lastRunAtTo=2026-01-31");
    expect(capturedUrl).toContain("status=ACTIVE");
  });

  it("triggers a run from the row action", async () => {
    let runCalled = false;
    server.use(
      http.get("/api/admin/scouts", () => HttpResponse.json(scoutsListResponse())),
      http.post("/api/admin/scouts/scout-1/run", () => {
        runCalled = true;
        return HttpResponse.json({ scoutId: "scout-1", scoutRunId: "run-1", status: "PENDING" });
      }),
    );

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(runCalled).toBe(true);
  });

  it("triggers pause from the row action for an Active scout", async () => {
    let pauseCalled = false;
    server.use(
      http.get("/api/admin/scouts", () => HttpResponse.json(scoutsListResponse())),
      http.post("/api/admin/scouts/scout-1/pause", () => {
        pauseCalled = true;
        return HttpResponse.json({ scoutId: "scout-1", status: "PAUSED" });
      }),
    );

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(pauseCalled).toBe(true);
  });

  it("triggers resume from the row action for a Paused scout, with no Run now button", async () => {
    let resumeCalled = false;
    server.use(
      http.get("/api/admin/scouts", () =>
        HttpResponse.json(
          scoutsListResponse({
            scouts: [
              {
                id: "scout-1",
                userId: "user-1",
                userName: "Ada Lovelace",
                userEmail: "user1@example.com",
                label: "Senior Backend — Remote EU",
                status: "PAUSED",
                matchThreshold: 70,
                lastRunAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ),
      ),
      http.post("/api/admin/scouts/scout-1/resume", () => {
        resumeCalled = true;
        return HttpResponse.json({ scoutId: "scout-1", status: "ACTIVE" });
      }),
    );

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.getByText("Never run")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(resumeCalled).toBe(true);
  });

  it("triggers archive from the row action", async () => {
    let archiveCalled = false;
    server.use(
      http.get("/api/admin/scouts", () => HttpResponse.json(scoutsListResponse())),
      http.post("/api/admin/scouts/scout-1/archive", () => {
        archiveCalled = true;
        return HttpResponse.json({ scoutId: "scout-1", status: "ARCHIVED" });
      }),
    );

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    await userEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(archiveCalled).toBe(true);
  });

  it("shows no Edit or Create control anywhere on this page, and no actions for an Archived scout", async () => {
    server.use(
      http.get("/api/admin/scouts", () =>
        HttpResponse.json(
          scoutsListResponse({
            scouts: [
              {
                id: "scout-1",
                userId: "user-1",
                userName: "Ada Lovelace",
                userEmail: "user1@example.com",
                label: "Senior Backend — Remote EU",
                status: "ARCHIVED",
                matchThreshold: 70,
                lastRunAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ),
      ),
    );

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("hides the id column by default, showing it with a copy button once toggled on from the Columns menu", async () => {
    const user = userEvent.setup();
    server.use(http.get("/api/admin/scouts", () => HttpResponse.json(scoutsListResponse())));

    renderWithProviders(<AdminScoutsPage />);
    await screen.findByText("Ada Lovelace");

    expect(screen.queryByText("scout-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "ID" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "ID" }),
    ).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "ID" }));
    await user.keyboard("{Escape}");

    expect(screen.getByText("scout-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
  });

  it("shows an empty state when no scouts match the filters", async () => {
    server.use(
      http.get("/api/admin/scouts", () =>
        HttpResponse.json(scoutsListResponse({ scouts: [], total: 0 })),
      ),
    );

    renderWithProviders(<AdminScoutsPage />);

    expect(await screen.findByText("No Scouts yet.")).toBeInTheDocument();
  });
});
