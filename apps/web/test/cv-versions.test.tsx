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

  it("hides Set as default and Replace (but keeps Reconvert) in the panel for a superseded CV", async () => {
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
    expect(panel.getByText("Replaced by New CV")).toBeInTheDocument();
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
