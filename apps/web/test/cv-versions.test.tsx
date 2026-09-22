import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import CvVersionsPage from "@/app/(app)/cv-versions/page";

const UPLOAD_URL = "https://uploads.example.test/put";

function cvVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv1",
    label: "Grad CV",
    fileName: "grad-cv.pdf",
    fileType: "PDF",
    fileSizeBytes: 12345,
    isDefault: false,
    conversionStatus: "CONVERTED",
    conversionError: null,
    supersededById: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function pdf(name = "cv.pdf", { size }: { size?: number } = {}) {
  const file = new File(["%PDF-1.4"], name, { type: "application/pdf" });
  if (size !== undefined) {
    Object.defineProperty(file, "size", { value: size });
  }
  return file;
}

describe("CvVersionsPage — list", () => {
  it("shows an 'Import a CV' entry point linking to /cv-versions/new instead of an inline form (issue #83)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(
      await screen.findByRole("link", { name: "Import a CV" }),
    ).toHaveAttribute("href", "/cv-versions/new");
    expect(screen.queryByLabelText("Label")).toBeNull();
    expect(screen.queryByLabelText("File")).toBeNull();
  });

  it("renders each CV version with its conversion status", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ conversionStatus: "CONVERTING" })],
        }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(await screen.findByText("Grad CV")).toBeInTheDocument();
    expect(screen.getByText("Converting")).toBeInTheDocument();
  });

  it("opens the CV panel on row click, fetching the Markdown rendition only once open (issue #81)", async () => {
    let markdownRequests = 0;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () => {
        markdownRequests += 1;
        return HttpResponse.json({
          markdownContent: "# Jane Doe\n\nStaff Engineer since 2019",
          conversionStatus: "CONVERTED",
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await screen.findByText("Grad CV");
    expect(markdownRequests).toBe(0);

    await user.click(screen.getByText("Grad CV"));

    const panel = within(await screen.findByRole("dialog"));
    expect(
      await panel.findByText(/Staff Engineer since 2019/),
    ).toBeInTheDocument();
    expect(markdownRequests).toBe(1);
  });

  it("notes next to the rendition that identity info was removed from it (issue #169)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({
          markdownContent: "Staff Engineer since 2019",
          conversionStatus: "CONVERTED",
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));

    const panel = within(await screen.findByRole("dialog"));
    expect(
      await panel.findByText(/Staff Engineer since 2019/),
    ).toBeInTheDocument();
    expect(
      panel.getByText(/identifying information .* was removed/i),
    ).toBeInTheDocument();
  });

  it("shows no redaction note when there is no rendition to show yet (issue #169)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "PENDING" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));

    const panel = within(await screen.findByRole("dialog"));
    expect(await panel.findByText(/hasn't been converted/)).toBeInTheDocument();
    expect(panel.queryByText(/identifying information/i)).not.toBeInTheDocument();
  });

  it("shows the CV's full info (file, size, dates, status, default state) in the panel", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ isDefault: true })],
        }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));

    const panel = within(await screen.findByRole("dialog"));
    expect(panel.getByText("grad-cv.pdf · PDF")).toBeInTheDocument();
    expect(panel.getByText("12.1 KB")).toBeInTheDocument();
    expect(panel.getByText("Converted")).toBeInTheDocument();
    expect(panel.getAllByText("Default").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the conversionError text in the panel for a FAILED CV", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({
              conversionStatus: "FAILED",
              conversionError: "no extractable text — is this a scanned PDF?",
            }),
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));

    const panel = within(await screen.findByRole("dialog"));
    expect(
      panel.getByText(/no extractable text — is this a scanned PDF\?/),
    ).toBeInTheDocument();
  });

  it("does not open the panel when clicking an inline action button", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.post("/api/cv-versions/cv1/convert", () =>
        HttpResponse.json({ conversionStatus: "PENDING" }, { status: 202 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(
      await screen.findByRole("button", { name: "Reconvert" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("triggers Reconvert and Set as default from the panel", async () => {
    let convertCalls = 0;
    let patchBody: Record<string, unknown> | null = null;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.post("/api/cv-versions/cv1/convert", () => {
        convertCalls += 1;
        return HttpResponse.json({ conversionStatus: "PENDING" }, { status: 202 });
      }),
      http.patch("/api/cv-versions/cv1", async ({ request }) => {
        patchBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ cvVersion: cvVersion({ isDefault: true }) });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));

    await user.click(panel.getByRole("button", { name: "Reconvert" }));
    await waitFor(() => expect(convertCalls).toBe(1));

    await user.click(panel.getByRole("button", { name: "Set as default" }));
    await waitFor(() => expect(patchBody).toEqual({ isDefault: true }));
  });

  it("hides Set as default, Replace, Modifier, and Delete (but keeps Reconvert) in the panel for a superseded CV", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Old CV", supersededById: "cv2" }),
            cvVersion({ id: "cv2", label: "New CV" }),
          ],
        }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(
      screen.getByRole("checkbox", { name: "Show superseded CV versions" }),
    );
    await user.click(await screen.findByText("Old CV"));

    const panel = within(await screen.findByRole("dialog"));
    expect(panel.getByRole("button", { name: "Reconvert" })).toBeEnabled();
    expect(
      panel.queryByRole("button", { name: "Set as default" }),
    ).toBeNull();
    expect(panel.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(panel.queryByRole("link", { name: "Modifier" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(panel.getByText("Replaced by New CV")).toBeInTheDocument();
  });

  it("shows a Modifier link in the panel to the edit page for an eligible CV version", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));

    expect(panel.getByRole("link", { name: "Modifier" })).toHaveAttribute(
      "href",
      "/cv-versions/cv1/edit",
    );
  });

  it("hides Modifier in the panel for a CV version that hasn't finished converting", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ conversionStatus: "PENDING" })],
        }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "PENDING" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));

    expect(panel.queryByRole("link", { name: "Modifier" })).toBeNull();
  });

  it("disables Modifier in the panel while a Reconvert is in flight, mirroring Reconvert's own busy state (issue #187)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.post("/api/cv-versions/cv1/convert", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ conversionStatus: "PENDING" }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    expect(panel.getByRole("link", { name: "Modifier" })).toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Reconvert" }));

    expect(panel.queryByRole("link", { name: "Modifier" })).toBeNull();
    expect(panel.getByRole("button", { name: "Modifier" })).toBeDisabled();
  });

  it("triggers a Conversion via POST /api/cv-versions/:id/convert", async () => {
    let convertCalls = 0;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ conversionStatus: "PENDING" })],
        }),
      ),
      http.post("/api/cv-versions/cv1/convert", () => {
        convertCalls += 1;
        return HttpResponse.json(
          { conversionStatus: "PENDING" },
          { status: 202 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(
      await screen.findByRole("button", { name: "Convert to Markdown" }),
    );

    await waitFor(() => expect(convertCalls).toBe(1));
  });

  it("labels the button 'Reconvert' once converted and disables it while CONVERTING", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cvA", conversionStatus: "CONVERTED" }),
            cvVersion({ id: "cvB", conversionStatus: "CONVERTING" }),
          ],
        }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(
      await screen.findByRole("button", { name: "Reconvert" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Converting…" })).toBeDisabled();
  });

  it("surfaces conversionError text on a FAILED row", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({
              conversionStatus: "FAILED",
              conversionError: "no extractable text — is this a scanned PDF?",
            }),
          ],
        }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(
      await screen.findByText(/no extractable text — is this a scanned PDF\?/),
    ).toBeInTheDocument();
  });

  it("sorts rows by label when the Label column header is clicked", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Zebra CV" }),
            cvVersion({ id: "cv2", label: "Alpha CV" }),
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await screen.findByText("Zebra CV");
    const rowLabel = () =>
      screen.getAllByRole("row").slice(1, 3).map((row) => row.textContent);
    // Default sort is by upload date; both fixtures share the same
    // `createdAt`, so insertion order ("Zebra CV" first) holds until sorted.
    expect(rowLabel()[0]).toContain("Zebra CV");

    await user.click(screen.getByRole("button", { name: "Label" }));
    expect(rowLabel()[0]).toContain("Alpha CV");

    await user.click(screen.getByRole("button", { name: "Label" }));
    expect(rowLabel()[0]).toContain("Zebra CV");
  });

  it("shows every column visible by default except id, with Label absent from the Columns menu (issue #130)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
    );

    renderWithProviders(<CvVersionsPage />);
    await screen.findByText("Grad CV");

    for (const name of ["Label", "File", "Size", "Uploaded", "Status", "Default"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("columnheader", { name: "ID" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    for (const name of ["ID", "File", "Size", "Uploaded", "Status", "Default"]) {
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
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion({ id: "cv-abc" })] }),
      ),
    );

    renderWithProviders(<CvVersionsPage />);
    await screen.findByText("Grad CV");

    expect(screen.queryByText("cv-abc")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "ID" }));
    await user.keyboard("{Escape}");

    expect(screen.getByText("cv-abc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
  });

  it("toggles a column's visibility independently and persists the choice across a remount, restored by Reset (issue #130)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
    );

    const { unmount } = renderWithProviders(<CvVersionsPage />);
    await screen.findByText("Grad CV");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "File" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("columnheader", { name: "File" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Size" })).toBeInTheDocument();
    expect(screen.queryByText("grad-cv.pdf · PDF")).not.toBeInTheDocument();

    unmount();
    renderWithProviders(<CvVersionsPage />);
    await screen.findByText("Grad CV");
    expect(screen.queryByRole("columnheader", { name: "File" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset" }));
    expect(screen.getByRole("columnheader", { name: "File" })).toBeInTheDocument();
  });

  it("keeps sorting on a column after it's hidden (issue #130)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Zebra CV", fileName: "zebra.pdf" }),
            cvVersion({ id: "cv2", label: "Alpha CV", fileName: "alpha.pdf" }),
          ],
        }),
      ),
    );

    renderWithProviders(<CvVersionsPage />);
    await screen.findByText("Zebra CV");

    await user.click(screen.getByRole("button", { name: "File" }));
    const rowLabel = () =>
      screen.getAllByRole("row").slice(1, 3).map((row) => row.textContent);
    expect(rowLabel()[0]).toContain("Alpha CV");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "File" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("columnheader", { name: "File" })).not.toBeInTheDocument();
    expect(rowLabel()[0]).toContain("Alpha CV");
  });

  it("truncates a long Label or file name with an ellipsis and reveals the full text in a tooltip on hover or focus (issue #132)", async () => {
    const user = userEvent.setup();
    const longLabel = "Senior Staff Backend Engineer CV for the Platform Team";
    const longFileName = "senior-staff-backend-engineer-cv-platform-team-2026.pdf";
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ label: longLabel, fileName: longFileName })],
        }),
      ),
    );

    renderWithProviders(<CvVersionsPage />);

    const truncatedLabel = await screen.findByText(
      `${longLabel.slice(0, 50)}…`,
    );
    const truncatedFileName = screen.getByText(
      `${longFileName.slice(0, 50)}…`,
    );
    expect(truncatedLabel).toBeInTheDocument();
    expect(truncatedFileName).toBeInTheDocument();

    truncatedLabel.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(longLabel);

    await user.hover(truncatedFileName);
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 2000 }),
    ).toHaveTextContent(longFileName);
  });

  it("renders a Label or file name at or under its limit unchanged, with no tooltip (issue #132)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
    );

    renderWithProviders(<CvVersionsPage />);
    await screen.findByText("Grad CV");

    expect(screen.getByText("grad-cv.pdf · PDF")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows an error state when the list fails to load", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't load your CV versions/i,
    );
  });

  it("sets a CV version as default and confirms it", async () => {
    let patchBody: Record<string, unknown> | null = null;
    let isDefault = false;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion({ isDefault })] }),
      ),
      http.patch("/api/cv-versions/cv1", async ({ request }) => {
        patchBody = (await request.json()) as Record<string, unknown>;
        isDefault = true;
        return HttpResponse.json({ cvVersion: cvVersion({ isDefault: true }) });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByRole("button", { name: "Set as default" }));

    expect(
      await screen.findByText("Default CV version updated."),
    ).toBeInTheDocument();
    expect(patchBody).toEqual({ isDefault: true });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Set as default" })).toBeNull(),
    );
  });

  it("hides a superseded CV version from the default view", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Old CV", supersededById: "cv2" }),
            cvVersion({ id: "cv2", label: "New CV" }),
          ],
        }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(await screen.findByText("New CV")).toBeInTheDocument();
    expect(screen.queryByText("Old CV")).toBeNull();
  });

  it("reveals superseded CV versions, labeled with their replacement, via the toggle", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Old CV", supersededById: "cv2" }),
            cvVersion({ id: "cv2", label: "New CV" }),
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await screen.findByText("New CV");
    expect(screen.queryByText("Old CV")).toBeNull();

    await user.click(
      screen.getByRole("checkbox", { name: "Show superseded CV versions" }),
    );

    expect(await screen.findByText("Old CV")).toBeInTheDocument();
    expect(screen.getByText("Replaced by New CV")).toBeInTheDocument();

    await user.click(
      screen.getByRole("checkbox", { name: "Show superseded CV versions" }),
    );

    expect(screen.queryByText("Old CV")).toBeNull();
  });

  it("refetches the CV versions list on demand, showing a busy state while in flight, without resetting the show-superseded toggle or sort (issue #123)", async () => {
    const user = userEvent.setup();
    let callCount = 0;
    let resolveSecondCall: () => void = () => {};
    const secondCallGate = new Promise<void>((resolve) => {
      resolveSecondCall = resolve;
    });
    server.use(
      http.get("/api/cv-versions", async () => {
        callCount += 1;
        const isRefresh = callCount === 2;
        if (isRefresh) {
          await secondCallGate;
        }
        return HttpResponse.json({
          cvVersions: [
            cvVersion({
              id: "cv1",
              label: "Old CV",
              supersededById: "cv2",
            }),
            cvVersion({
              id: "cv2",
              label: callCount >= 2 ? "New CV (updated)" : "New CV",
            }),
          ],
        });
      }),
    );

    renderWithProviders(<CvVersionsPage />);
    expect(await screen.findByText("New CV")).toBeInTheDocument();

    await user.click(
      screen.getByRole("checkbox", { name: "Show superseded CV versions" }),
    );
    expect(await screen.findByText("Old CV")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Label" }));
    const rowLabel = () =>
      screen.getAllByRole("row").slice(1, 3).map((row) => row.textContent);
    expect(rowLabel()[0]).toContain("New CV");

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    await user.click(refreshButton);
    expect(refreshButton).toBeDisabled();

    resolveSecondCall();
    await waitFor(() => expect(refreshButton).not.toBeDisabled());

    expect(callCount).toBe(2);
    expect(screen.getByText("New CV (updated)")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Show superseded CV versions" }),
    ).toBeChecked();
    expect(screen.getByText("Old CV")).toBeInTheDocument();
    expect(rowLabel()[0]).toContain("New CV (updated)");
  });
});

describe("CvVersionsPage — replace (from the panel, issue #82)", () => {
  it("does not render a Replace button or form on the row itself", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    await screen.findByText("Grad CV");
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.queryByLabelText("New label")).toBeNull();
  });

  it("opens a form pre-filled with the current label, replaces, and switches the panel to the new CV", async () => {
    let replaceBody: Record<string, unknown> | null = null;
    let replaced = false;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: replaced
            ? [
                cvVersion({
                  id: "cv2",
                  label: "Updated CV",
                  conversionStatus: "PENDING",
                }),
              ]
            : [cvVersion()],
        }),
      ),
      http.post("/api/cv-versions/cv1/replace", async ({ request }) => {
        replaceBody = (await request.json()) as Record<string, unknown>;
        replaced = true;
        return HttpResponse.json(
          { cvVersionId: "cv2", fileKey: "k", uploadUrl: UPLOAD_URL },
          { status: 201 },
        );
      }),
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 200 })),
      http.get("/api/cv-versions/cv2/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "PENDING" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Replace" }));

    const labelInput = panel.getByLabelText("New label") as HTMLInputElement;
    expect(labelInput.value).toBe("Grad CV");
    await user.clear(labelInput);
    await user.type(labelInput, "Updated CV");
    await user.upload(panel.getByLabelText("New file"), pdf("updated.pdf"));
    await user.click(panel.getByRole("button", { name: "Replace" }));

    // Panel switches to the newly created CV (new id, PENDING status) rather
    // than closing or lingering on the now-superseded one.
    await waitFor(() =>
      expect(panel.getByText("Pending")).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("dialog")).getByText("Updated CV")).toBeInTheDocument();
    expect(replaceBody).toMatchObject({
      label: "Updated CV",
      fileName: "updated.pdf",
      contentType: "application/pdf",
    });
  });

  it("closes the replace form on cancel without submitting", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Replace" }));
    expect(panel.getByLabelText("New label")).toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Cancel" }));
    expect(panel.queryByLabelText("New label")).toBeNull();
    expect(
      panel.getByRole("button", { name: "Replace" }),
    ).toBeInTheDocument();
  });

  it("warns about Scouts still pointing at the just-replaced CV version, linking to each edit form", async () => {
    let replaced = false;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: replaced
            ? [cvVersion({ id: "cv2", label: "Updated CV" })]
            : [cvVersion()],
        }),
      ),
      http.post("/api/cv-versions/cv1/replace", async () => {
        replaced = true;
        return HttpResponse.json(
          { cvVersionId: "cv2", fileKey: "k", uploadUrl: UPLOAD_URL },
          { status: 201 },
        );
      }),
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 200 })),
      http.get("/api/cv-versions/cv2/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.get("/api/scouts", () =>
        HttpResponse.json({
          scouts: [
            {
              id: "scout1",
              userId: "u1",
              label: "Backend roles",
              cvVersionId: "cv1",
              targetSiteKeys: [],
              filters: {
                keywords: null,
                location: null,
                postedWithin: null,
                contractType: null,
                remote: null,
                experienceLevel: null,
              },
              matchThreshold: 70,
              status: "ACTIVE",
              lastRunAt: null,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              relevantFindsCount: 0,
            },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Replace" }));
    await user.upload(panel.getByLabelText("New file"), pdf("updated.pdf"));
    await user.click(panel.getByRole("button", { name: "Replace" }));

    // The panel (a modal Sheet) stays open after a successful Replace, so
    // Radix marks the page's background — including this banner — aria-hidden
    // until the panel is closed; query with `hidden: true` to see it anyway.
    expect(await screen.findByText("Backend roles")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Backend roles", hidden: true }),
    ).toHaveAttribute("href", "/scouts/scout1/edit");
  });

  it("shows no Scout warning when no Scout references the just-replaced CV version", async () => {
    let replaced = false;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: replaced
            ? [cvVersion({ id: "cv2", label: "Updated CV" })]
            : [cvVersion()],
        }),
      ),
      http.post("/api/cv-versions/cv1/replace", async () => {
        replaced = true;
        return HttpResponse.json(
          { cvVersionId: "cv2", fileKey: "k", uploadUrl: UPLOAD_URL },
          { status: 201 },
        );
      }),
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 200 })),
      http.get("/api/cv-versions/cv2/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Replace" }));
    await user.upload(panel.getByLabelText("New file"), pdf("updated.pdf"));
    await user.click(panel.getByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByText("Updated CV")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert", { name: /still used/i })).toBeNull();
  });
});

describe("CvVersionsPage — delete (docs/adr/0027)", () => {
  it("asks for confirmation naming just this CV when it has no earlier versions", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Delete" }));

    expect(
      await panel.findByText(
        "This CV will be permanently deleted. This can't be undone.",
      ),
    ).toBeInTheDocument();
  });

  it("names the number of earlier versions in the confirmation for a CV with a supersede chain", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [
            cvVersion({ id: "cv1", label: "Old CV", supersededById: "cv2" }),
            cvVersion({ id: "cv2", label: "New CV" }),
          ],
        }),
      ),
      http.get("/api/cv-versions/cv2/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    // Opened from the current version — the chain also includes the
    // superseded "Old CV" row, so deleting removes both (docs/adr/0027).
    await user.click(await screen.findByText("New CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Delete" }));

    expect(
      await panel.findByText(
        "This CV and its 1 earlier version will be permanently deleted. This can't be undone.",
      ),
    ).toBeInTheDocument();
  });

  it("cancels the confirmation without calling the delete endpoint", async () => {
    let deleteCalls = 0;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.delete("/api/cv-versions/cv1", () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Delete" }));
    await user.click(panel.getByRole("button", { name: "Cancel" }));

    expect(panel.queryByText(/permanently deleted/)).toBeNull();
    expect(panel.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(deleteCalls).toBe(0);
  });

  it("deletes the CV via DELETE /api/cv-versions/:id on confirmation, closing the panel like its own close button and refetching the list like Actualiser", async () => {
    let getCalls = 0;
    server.use(
      http.get("/api/cv-versions", () => {
        getCalls += 1;
        return HttpResponse.json({ cvVersions: getCalls > 1 ? [] : [cvVersion()] });
      }),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.delete("/api/cv-versions/cv1", () => new HttpResponse(null, { status: 204 })),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Delete" }));
    await user.click(panel.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(getCalls).toBeGreaterThan(1));
    expect(
      await screen.findByText("No CV versions uploaded yet."),
    ).toBeInTheDocument();
  });

  it("disables every other action in the panel while the delete request is pending", async () => {
    let resolveDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.delete("/api/cv-versions/cv1", async () => {
        await deleteGate;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Delete" }));
    await user.click(panel.getByRole("button", { name: "Confirm" }));

    expect(panel.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Reconvert" })).toBeDisabled();
    expect(
      panel.getByRole("button", { name: "Set as default" }),
    ).toBeDisabled();
    expect(panel.getByRole("button", { name: "Replace" })).toBeDisabled();

    resolveDelete();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a generic error and keeps the panel open when delete is rejected (e.g. a version was analysed)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cvVersion()] }),
      ),
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: null, conversionStatus: "CONVERTED" }),
      ),
      http.delete("/api/cv-versions/cv1", () =>
        HttpResponse.json(
          { detail: "This CV is used by 1 Analysis(es). It cannot be deleted while those Analyses reference it." },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByText("Grad CV"));
    const panel = within(await screen.findByRole("dialog"));
    await user.click(panel.getByRole("button", { name: "Delete" }));
    await user.click(panel.getByRole("button", { name: "Confirm" }));

    expect(
      await panel.findByText(
        "We couldn't delete that CV. It may still be in use — please try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
