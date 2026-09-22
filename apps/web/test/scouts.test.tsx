import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import { __getUrl, __setUrl } from "./next-navigation-mock";
import ScoutsPage from "@/app/(app)/scouts/page";
import NewScoutPage from "@/app/(app)/scouts/new/page";

vi.mock("next/navigation", async () => {
  const mock = await vi.importActual<typeof import("./next-navigation-mock")>(
    "./next-navigation-mock",
  );
  return mock;
});

beforeEach(() => {
  __setUrl("/scouts");
});

afterEach(() => {
  __setUrl("/scouts");
});

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

function scout(overrides: Record<string, unknown> = {}) {
  return {
    id: "scout-1",
    userId: "user_1",
    label: "Senior Backend — Remote EU",
    cvVersionId: "cv-default",
    targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN"],
    filters: {
      keywords: "python",
      location: null,
      postedWithin: "7d",
      contractType: null,
      remote: null,
      experienceLevel: null,
    },
    matchThreshold: 70,
    status: "ACTIVE",
    lastRunAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScoutsPage — list", () => {
  it("lists each Scout with its status and base CV and a New Scout link, with the Label as plain text (issue #91)", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(
      await screen.findByText("Senior Backend — Remote EU"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Senior Backend — Remote EU" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Default CV/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New Scout" })).toHaveAttribute(
      "href",
      "/scouts/new",
    );
  });

  it("renders the Status, Base CV, Sites, Last run, and Relevant finds columns", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [
            scout({
              lastRunAt: "2026-09-10T00:00:00.000Z",
              relevantFindsCount: 3,
            }),
          ],
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    const row = (await screen.findByText(
      "Senior Backend — Remote EU",
    )).closest("tr");
    expect(row).not.toBeNull();
    const withinRow = within(row as HTMLElement);
    expect(withinRow.getByText("Active")).toBeInTheDocument();
    expect(withinRow.getByText("Default CV")).toBeInTheDocument();
    expect(withinRow.getByText("2 sites")).toBeInTheDocument();
    expect(
      withinRow.getByText(new Date("2026-09-10T00:00:00.000Z").toLocaleDateString()),
    ).toBeInTheDocument();
    expect(withinRow.getByText("3")).toBeInTheDocument();
  });

  it("renders \"Never run\" for a Scout with no lastRunAt", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({ scouts: [scout({ lastRunAt: null })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(await screen.findByText("Never run")).toBeInTheDocument();
  });

  it("sorts rows by label when the Label column header is clicked", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [
            scout({ id: "scout-z", label: "Zebra Scout", lastRunAt: "2026-09-10T00:00:00.000Z" }),
            scout({ id: "scout-a", label: "Alpha Scout", lastRunAt: "2026-09-10T00:00:00.000Z" }),
          ],
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await screen.findByText("Zebra Scout");
    const rowLabel = () =>
      screen.getAllByRole("row").slice(1, 3).map((row) => row.textContent);
    // Default sort is Last run, descending; both fixtures share the same
    // lastRunAt, so insertion order ("Zebra Scout" first) holds until sorted.
    expect(rowLabel()[0]).toContain("Zebra Scout");

    await user.click(screen.getByRole("button", { name: "Label" }));
    expect(rowLabel()[0]).toContain("Alpha Scout");

    await user.click(screen.getByRole("button", { name: "Label" }));
    expect(rowLabel()[0]).toContain("Zebra Scout");
  });

  it("shows every column visible by default except id, with Label absent from the Columns menu", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);
    await screen.findByText("Senior Backend — Remote EU");

    for (const name of [
      "Label",
      "Status",
      "Base CV",
      "Sites",
      "Last run",
      "Relevant finds",
    ]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("columnheader", { name: "ID" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    for (const name of [
      "ID",
      "Status",
      "Base CV",
      "Sites",
      "Last run",
      "Relevant finds",
    ]) {
      expect(
        screen.getByRole("menuitemcheckbox", { name }),
      ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Label" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "ID" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("shows the id column with a copy button once toggled on from the Columns menu, hidden by default", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout({ id: "scout-abc" })] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);
    await screen.findByText("Senior Backend — Remote EU");

    expect(screen.queryByText("scout-abc")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "ID" }));
    await user.keyboard("{Escape}");

    expect(screen.getByText("scout-abc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
  });

  it("toggles a column's visibility independently and persists the choice across a remount, restored by Reset (issue #131)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    const { unmount } = renderWithProviders(<ScoutsPage />);
    await screen.findByText("Senior Backend — Remote EU");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Status" }));
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("columnheader", { name: "Status" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Base CV" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();

    unmount();
    renderWithProviders(<ScoutsPage />);
    await screen.findByText("Senior Backend — Remote EU");
    expect(
      screen.queryByRole("columnheader", { name: "Status" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset" }));
    expect(
      screen.getByRole("columnheader", { name: "Status" }),
    ).toBeInTheDocument();
  });

  it("keeps sorting on a column after it's hidden (issue #131)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [
            scout({
              id: "scout-z",
              label: "Zebra Scout",
              lastRunAt: "2026-09-10T00:00:00.000Z",
            }),
            scout({
              id: "scout-a",
              label: "Alpha Scout",
              lastRunAt: "2026-09-10T00:00:00.000Z",
            }),
          ],
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);
    await screen.findByText("Zebra Scout");

    await user.click(screen.getByRole("button", { name: "Label" }));
    const rowLabel = () =>
      screen.getAllByRole("row").slice(1, 3).map((row) => row.textContent);
    expect(rowLabel()[0]).toContain("Alpha Scout");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Status" }));
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("columnheader", { name: "Status" }),
    ).not.toBeInTheDocument();
    expect(rowLabel()[0]).toContain("Alpha Scout");
  });

  it("truncates a long Label with an ellipsis and reveals the full text in a tooltip on hover or focus (issue #133)", async () => {
    const user = userEvent.setup();
    const longLabel =
      "Senior Staff Backend Engineer — Remote EU, Python and Kubernetes focus";
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({ scouts: [scout({ label: longLabel })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    const truncatedLabel = await screen.findByText(
      `${longLabel.slice(0, 50)}…`,
    );
    expect(truncatedLabel).toBeInTheDocument();

    truncatedLabel.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(longLabel);

    await user.hover(truncatedLabel);
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 2000 }),
    ).toHaveTextContent(longLabel);
  });

  it("renders a Label at or under its limit unchanged, with no tooltip (issue #133)", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);
    await screen.findByText("Senior Backend — Remote EU");

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("hides an Archived Scout from the default view", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [
            scout({ id: "scout-archived", label: "Old Scout", status: "ARCHIVED" }),
            scout({ id: "scout-active", label: "Active Scout" }),
          ],
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    renderWithProviders(<ScoutsPage />);

    expect(await screen.findByText("Active Scout")).toBeInTheDocument();
    expect(screen.queryByText("Old Scout")).toBeNull();
  });

  it("reveals Archived Scouts via the show-archived toggle, and re-hides them when unchecked", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [
            scout({ id: "scout-archived", label: "Old Scout", status: "ARCHIVED" }),
            scout({ id: "scout-active", label: "Active Scout" }),
          ],
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await screen.findByText("Active Scout");
    expect(screen.queryByText("Old Scout")).toBeNull();

    await user.click(
      screen.getByRole("checkbox", { name: "Show archived Scouts" }),
    );
    expect(await screen.findByText("Old Scout")).toBeInTheDocument();

    await user.click(
      screen.getByRole("checkbox", { name: "Show archived Scouts" }),
    );
    expect(screen.queryByText("Old Scout")).toBeNull();
  });

  it("shows an empty state when there are no Scouts", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(
      await screen.findByText("You don't have any Scouts yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't load your Scouts.",
    );
  });

  it("opens the Scout panel on row click, showing status, base CV, full site names, threshold, filters, and last run (issue #91)", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [scout({ lastRunAt: "2026-09-10T00:00:00.000Z" })],
        }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await user.click(await screen.findByText("Senior Backend — Remote EU"));

    const panel = within(await screen.findByRole("dialog"));
    expect(panel.getAllByText("Senior Backend — Remote EU").length).toBeGreaterThan(0);
    expect(panel.getByText("Configuration")).toBeInTheDocument();
    expect(panel.getByText("Active")).toBeInTheDocument();
    expect(panel.getByText("Default CV")).toBeInTheDocument();
    expect(panel.getByText("France Travail, LinkedIn")).toBeInTheDocument();
    expect(panel.getByText("70")).toBeInTheDocument();
    expect(
      panel.getByText("keywords: python, postedWithin: 7d"),
    ).toBeInTheDocument();
    expect(
      panel.getByText(new Date("2026-09-10T00:00:00.000Z").toLocaleString()),
    ).toBeInTheDocument();
  });

  it("opens the Scout panel via keyboard when a row is focused (Enter or Space)", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    const row = (await screen.findByText("Senior Backend — Remote EU")).closest(
      "tr",
    ) as HTMLElement;
    row.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens the panel for the Scout named in a `?open=` query param, then clears it from the URL (issue #92)", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    __setUrl("/scouts?open=scout-1");

    renderWithProviders(<ScoutsPage />);

    const panel = within(await screen.findByRole("dialog"));
    expect(
      (await panel.findAllByText("Senior Backend — Remote EU")).length,
    ).toBeGreaterThan(0);
    await waitFor(() => expect(__getUrl()).toBe("/scouts"));
  });

  it("triggers Run now from the panel and surfaces the once-per-hour rate-limit error", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts/scout-1/run", () =>
        HttpResponse.json(
          { error: "This Scout ran within the last hour. Try again later." },
          { status: 429 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await user.click(await screen.findByText("Senior Backend — Remote EU"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Run now" }));

    expect(await panel.findByRole("alert")).toHaveTextContent(
      "This Scout ran within the last hour.",
    );
  });

  it("hides Run now / Pause / Resume / Archive in the panel for an Archived Scout", async () => {
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({ scouts: [scout({ status: "ARCHIVED" })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await user.click(
      await screen.findByRole("checkbox", { name: "Show archived Scouts" }),
    );
    await user.click(await screen.findByText("Senior Backend — Remote EU"));
    const panel = within(await screen.findByRole("dialog"));

    expect(panel.queryByRole("button", { name: "Run now" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("calls the status-patch mutation for Pause, Resume, and Archive from the panel", async () => {
    const patches: unknown[] = [];
    server.use(
      http.get("/api/scouts", () =>
        HttpResponse.json({ scouts: [scout({ status: "ACTIVE" })] }),
      ),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.patch("/api/scouts/scout-1", async ({ request }) => {
        const body = await request.json();
        patches.push(body);
        return HttpResponse.json({ scout: scout({ ...(body as object) }) });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await user.click(await screen.findByText("Senior Backend — Remote EU"));
    const panel = within(await screen.findByRole("dialog"));

    await user.click(panel.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(patches).toContainEqual({ status: "PAUSED" }),
    );

    await user.click(panel.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(patches).toContainEqual({ status: "ARCHIVED" }),
    );
  });

  it("includes an Edit link in the panel, with no more 'view full detail' link now that the panel absorbs it (issue #92)", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScoutsPage />);

    await user.click(await screen.findByText("Senior Backend — Remote EU"));
    const panel = within(await screen.findByRole("dialog"));

    expect(panel.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/scouts/scout-1/edit",
    );
    expect(
      panel.queryByRole("link", { name: "View full detail" }),
    ).not.toBeInTheDocument();
  });

  it("refetches the scouts list on demand, showing a busy state while in flight, without resetting the show-archived toggle or sort (issue #122)", async () => {
    const user = userEvent.setup();
    let callCount = 0;
    let resolveSecondCall: () => void = () => {};
    const secondCallGate = new Promise<void>((resolve) => {
      resolveSecondCall = resolve;
    });
    server.use(
      http.get("/api/scouts", async () => {
        callCount += 1;
        const isRefresh = callCount === 2;
        if (isRefresh) {
          await secondCallGate;
        }
        return HttpResponse.json({
          scouts: [
            scout({
              id: "scout-archived",
              label: "Old Scout",
              status: "ARCHIVED",
            }),
            scout({
              id: "scout-active",
              label: callCount >= 2 ? "Active Scout (updated)" : "Active Scout",
            }),
          ],
        });
      }),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);
    expect(await screen.findByText("Active Scout")).toBeInTheDocument();

    await user.click(
      screen.getByRole("checkbox", { name: "Show archived Scouts" }),
    );
    expect(await screen.findByText("Old Scout")).toBeInTheDocument();

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();

    resolveSecondCall();
    await waitFor(() => expect(refreshButton).not.toBeDisabled());

    expect(callCount).toBe(2);
    expect(screen.getByText("Active Scout (updated)")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Show archived Scouts" }),
    ).toBeChecked();
    expect(screen.getByText("Old Scout")).toBeInTheDocument();
  });
});

describe("NewScoutPage — create form", () => {
  it("pre-checks France Travail and defaults the threshold to 70", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<NewScoutPage />);

    const franceTravail = await screen.findByRole("checkbox", {
      name: "France Travail",
    });
    expect(franceTravail).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "LinkedIn" })).not.toBeChecked();
    expect(screen.getByLabelText("Relevance threshold")).toHaveValue(70);
  });

  it("excludes a superseded CV from the picker entirely", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cv({ id: "cv-old", label: "Old CV", isDefault: false, supersededById: "cv-default" }),
            cv(),
          ],
        }),
      ),
    );

    renderWithProviders(<NewScoutPage />);

    const select = await screen.findByLabelText("CV version");
    expect(
      within(select).queryByRole("option", { name: /Old CV/ }),
    ).not.toBeInTheDocument();
    expect(
      within(select).getByRole("option", { name: /Default CV/ }),
    ).toBeInTheDocument();
  });

  it("styles the site checkboxes with the design system's accent and a visible focus ring", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<NewScoutPage />);

    const franceTravail = await screen.findByRole("checkbox", {
      name: "France Travail",
    });
    // Bare native checkboxes render with browser-default chrome that ignores
    // the app's dark theme and has no visible focus indicator — issue #53's
    // deferred a11y/dark-mode pass. Both the checked fill and the focus ring
    // must come from design tokens, not browser defaults.
    expect(franceTravail.className).toMatch(/accent-accent/);
    expect(franceTravail.className).toMatch(/focus-visible:ring-2/);
  });

  it("does not preselect the default CV — submit stays disabled until one is chosen", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    renderWithProviders(<NewScoutPage />);

    const select = await screen.findByLabelText("CV version");
    expect(select).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Create Scout" }),
    ).toBeDisabled();
  });

  it("validates an empty label and at least one site", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.selectOptions(
      await screen.findByLabelText("CV version"),
      "cv-default",
    );
    await user.click(await screen.findByRole("checkbox", { name: "France Travail" }));
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    expect(
      await screen.findByText("Give this Scout a label."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose at least one job site."),
    ).toBeInTheDocument();
    expect(__getUrl()).toBe("/scouts");
  });

  it("submits the configured Scout and redirects to the list", async () => {
    const received: unknown[] = [];
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ scout: scout() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(
      await screen.findByLabelText("Label"),
      "Senior Backend — Remote EU",
    );
    await user.selectOptions(screen.getByLabelText("CV version"), "cv-default");
    await user.click(screen.getByRole("checkbox", { name: "LinkedIn" }));
    await user.type(screen.getByLabelText("Keywords"), "python");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    await waitFor(() => expect(__getUrl()).toBe("/scouts"));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      label: "Senior Backend — Remote EU",
      cvVersionId: "cv-default",
      targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN"],
      matchThreshold: 70,
      filters: { keywords: "python", postedWithin: "7d" },
    });
  });

  it("submits the shared job-search filters (contract type, remote, experience level)", async () => {
    const received: unknown[] = [];
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ scout: scout() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(await screen.findByLabelText("Label"), "Filtered Scout");
    await user.selectOptions(screen.getByLabelText("CV version"), "cv-default");
    await user.type(screen.getByLabelText("Contract type"), "CDI");
    await user.selectOptions(screen.getByLabelText("Remote policy"), "remote");
    await user.type(screen.getByLabelText("Experience level"), "senior");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      filters: {
        contractType: "CDI",
        remote: "remote",
        experienceLevel: "senior",
        postedWithin: "7d",
      },
    });
  });

  it("shows an error when the server rejects the create (e.g. Scout cap)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", () =>
        HttpResponse.json(
          { error: "You can have at most 5 active Scouts." },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(await screen.findByLabelText("Label"), "Sixth Scout");
    await user.selectOptions(screen.getByLabelText("CV version"), "cv-default");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't save that Scout.");
    expect(__getUrl()).toBe("/scouts");
  });
});

// These three describe blocks used to render the standalone `/scouts/[id]`
// detail page directly; that route is gone (issue #92 — the panel now
// absorbs it, superseding docs/adr/0006), so each opens the Scout panel from
// the list instead and scopes its queries to it.
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<ScoutsPage />);
  await user.click(await screen.findByText("Senior Backend — Remote EU"));
  return within(await screen.findByRole("dialog"));
}

describe("Scout panel — Run now + run history", () => {
  const scoutRun = (overrides: Record<string, unknown> = {}) => ({
    id: "run-1",
    scoutId: "scout-1",
    status: "COMPLETED",
    sitesQueried: 2,
    siteUnavailableCount: 0,
    offersDiscovered: 0,
    offersAnalysed: 0,
    relevantCount: 0,
    failedCount: 0,
    alreadySeenCount: 0,
    runLimitSkippedCount: 0,
    capSkippedCount: 0,
    errorMessage: null,
    startedAt: "2026-09-11T00:00:00.000Z",
    finishedAt: "2026-09-11T00:00:05.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  });

  it("triggers a run and shows the run history", async () => {
    const runPosts: unknown[] = [];
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () =>
        HttpResponse.json({ scoutRuns: runPosts.length ? [scoutRun()] : [] }),
      ),
      http.post("/api/scouts/scout-1/run", () => {
        runPosts.push(true);
        return HttpResponse.json({ scoutRun: scoutRun({ status: "PENDING" }) }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(await panel.findByText("This Scout hasn't run yet.")).toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Run now" }));

    await waitFor(() => expect(runPosts).toHaveLength(1));
    expect(await panel.findByText("Completed")).toBeInTheDocument();
    expect(panel.getByText("2 sites queried")).toBeInTheDocument();
  });

  it("surfaces the once-per-hour rate limit", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () => HttpResponse.json({ scoutRuns: [] })),
      http.post("/api/scouts/scout-1/run", () =>
        HttpResponse.json(
          { error: "This Scout ran within the last hour. Try again later." },
          { status: 429 },
        ),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    await user.click(panel.getByRole("button", { name: "Run now" }));

    const alert = await panel.findByRole("alert");
    expect(alert).toHaveTextContent("This Scout ran within the last hour.");
  });

  it("surfaces the cost-bounded-matching skip counts when non-zero", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/runs", () =>
        HttpResponse.json({
          scoutRuns: [
            scoutRun({
              alreadySeenCount: 3,
              runLimitSkippedCount: 2,
              capSkippedCount: 1,
            }),
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(await panel.findByText("3 already seen")).toBeInTheDocument();
    expect(panel.getByText("2 not analysed — run limit")).toBeInTheDocument();
    expect(panel.getByText("1 not analysed — daily limit")).toBeInTheDocument();
  });
});

describe("Scout panel — relevant finds (issue #56)", () => {
  function find(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      status: "COMPLETED",
      matchScore: 85,
      requestedAt: "2026-09-11T00:00:00.000Z",
      cvVersionId: "cv-default",
      ingestionJobId: "job-1",
      scoutId: "scout-1",
      ingestionJob: null,
      jobOffer: { id: "offer-1", title: "Backend Engineer", company: "Acme" },
      cvVersion: { label: "Default CV" },
      resultJSON: null,
      errorMessage: null,
      ...overrides,
    };
  }

  it("lists relevant finds separately from found — low fit", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/finds", () =>
        HttpResponse.json({
          relevantFinds: [find({ id: "a1", jobOffer: { id: "o1", title: "Backend Engineer", company: "Acme" } })],
          lowFitFinds: [find({ id: "a2", matchScore: 40, jobOffer: { id: "o2", title: "Support Rep", company: "Beta" } })],
        }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    const relevant = within(
      (await panel.findByText("Relevant finds")).closest("div") as HTMLElement,
    );
    expect(relevant.getByText("Backend Engineer")).toBeInTheDocument();

    const lowFit = within(
      panel.getByText("Found — low fit").closest("div") as HTMLElement,
    );
    expect(lowFit.getByText("Support Rep")).toBeInTheDocument();
  });

  it("shows an empty state when there are no relevant finds yet, and hides the low-fit card", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/finds", () =>
        HttpResponse.json({ relevantFinds: [], lowFitFinds: [] }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(await panel.findByText("No relevant finds yet.")).toBeInTheDocument();
    expect(panel.queryByText("Found — low fit")).not.toBeInTheDocument();
  });
});

describe("Scout panel — stats and patterns (issue #60)", () => {
  it("shows the scoped stats header", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/stats", () =>
        HttpResponse.json({
          allTime: {
            offersDiscovered: 40,
            relevantFinds: 5,
            documentsGenerated: 2,
            applicationsSubmitted: 1,
            responseRate: 100,
            interviewRate: 0,
            offerRate: 0,
            acceptanceRate: 0,
            medianDaysToFirstResponse: 4,
          },
          last30Days: {
            offersDiscovered: 40,
            relevantFinds: 5,
            documentsGenerated: 2,
            applicationsSubmitted: 1,
            responseRate: 100,
            interviewRate: 0,
            offerRate: 0,
            acceptanceRate: 0,
            medianDaysToFirstResponse: 4,
          },
        }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(panel.getByText("Stats")).toBeInTheDocument();
    expect(await panel.findByText("Offers discovered")).toBeInTheDocument();
    expect(panel.getByText("40")).toBeInTheDocument();
  });

  it("ranks the patterns panel's missing skills by frequency", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/patterns", () =>
        HttpResponse.json({
          patterns: [
            { skill: "Kubernetes", count: 3 },
            { skill: "GraphQL", count: 1 },
          ],
          weaknesses: [],
        }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(await panel.findByText("Kubernetes")).toBeInTheDocument();
    expect(panel.getByText("GraphQL")).toBeInTheDocument();
  });

  it("ranks the patterns panel's recurring weaknesses by frequency", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/patterns", () =>
        HttpResponse.json({
          patterns: [],
          weaknesses: [
            { weakness: "Limited cloud experience", count: 2 },
            { weakness: "No team leadership", count: 1 },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(await panel.findByText("Limited cloud experience")).toBeInTheDocument();
    expect(panel.getByText("No team leadership")).toBeInTheDocument();
  });

  it("shows an empty state when there are no patterns yet", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () => HttpResponse.json({ cvVersions: [cv()] })),
      http.get("/api/scouts/scout-1/patterns", () =>
        HttpResponse.json({ patterns: [], weaknesses: [] }),
      ),
    );
    const user = userEvent.setup();
    const panel = await openPanel(user);

    expect(
      await panel.findByText("No patterns yet — they'll appear as relevant finds accumulate."),
    ).toBeInTheDocument();
    expect(
      await panel.findByText(
        "No recurring weaknesses yet — they'll appear as relevant finds accumulate.",
      ),
    ).toBeInTheDocument();
  });
});
