import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor } from "./test-utils";
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

describe("CvVersionsPage — upload form", () => {
  it("shows inline validation when submitting with no label and no file", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText("Give this CV version a label."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose a PDF, DOCX, Markdown, or plain-text file."),
    ).toBeInTheDocument();
  });

  it("rejects an unsupported file type with a type message", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.type(screen.getByLabelText("Label"), "My CV");
    // Named `.pdf` (so the <input accept> lets user-event set it) but with an
    // unsupported media type, so the zod content-type check is what rejects it.
    await user.upload(
      screen.getByLabelText("File"),
      new File(["hi"], "notes.pdf", { type: "application/rtf" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText(
        "Only PDF, DOCX, Markdown, and plain-text files are supported.",
      ),
    ).toBeInTheDocument();
  });

  it("accepts a Markdown file", async () => {
    let createBody: Record<string, unknown> | null = null;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
      http.post("/api/cv-versions", async ({ request }) => {
        createBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { cvVersionId: "cvmd", fileKey: "k", uploadUrl: UPLOAD_URL },
          { status: 201 },
        );
      }),
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 200 })),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.type(screen.getByLabelText("Label"), "Markdown CV");
    await user.upload(
      screen.getByLabelText("File"),
      new File(["# CV"], "cv.md", { type: "text/markdown" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("CV version uploaded.")).toBeInTheDocument();
    expect(createBody).toMatchObject({
      fileName: "cv.md",
      contentType: "text/markdown",
    });
  });

  it("rejects a file over the 10 MB limit", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.type(screen.getByLabelText("Label"), "My CV");
    await user.upload(
      screen.getByLabelText("File"),
      pdf("big.pdf", { size: 11 * 1024 * 1024 }),
    );
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText("That file is larger than the 10 MB limit."),
    ).toBeInTheDocument();
  });

  it("creates the CV version, PUTs the file, and confirms success", async () => {
    let createBody: Record<string, unknown> | null = null;
    let putReceived = false;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
      http.post("/api/cv-versions", async ({ request }) => {
        createBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { cvVersionId: "cv9", fileKey: "k", uploadUrl: UPLOAD_URL },
          { status: 201 },
        );
      }),
      http.put(UPLOAD_URL, () => {
        putReceived = true;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.type(screen.getByLabelText("Label"), "Fintech CV");
    await user.upload(screen.getByLabelText("File"), pdf("fintech.pdf"));
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("CV version uploaded.")).toBeInTheDocument();
    expect(putReceived).toBe(true);
    expect(createBody).toMatchObject({
      label: "Fintech CV",
      fileName: "fintech.pdf",
      contentType: "application/pdf",
    });
  });
});

describe("CvVersionsPage — list", () => {
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

  it("fetches and shows the Markdown rendition only after the panel is opened", async () => {
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
    expect(screen.queryByText(/Staff Engineer since 2019/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "View Markdown" }));

    expect(
      await screen.findByText(/Staff Engineer since 2019/),
    ).toBeInTheDocument();
    expect(markdownRequests).toBe(1);

    await user.click(screen.getByRole("button", { name: "Hide Markdown" }));
    await waitFor(() =>
      expect(screen.queryByText(/Staff Engineer since 2019/)).toBeNull(),
    );
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
});

describe("CvVersionsPage — replace", () => {
  it("opens a form pre-filled with the current label, replaces, and drops the old row from the list", async () => {
    let replaceBody: Record<string, unknown> | null = null;
    let replaced = false;
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: replaced
            ? [cvVersion({ id: "cv2", label: "Updated CV" })]
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
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByRole("button", { name: "Replace" }));

    const labelInput = screen.getByLabelText("New label") as HTMLInputElement;
    expect(labelInput.value).toBe("Grad CV");
    await user.clear(labelInput);
    await user.type(labelInput, "Updated CV");
    await user.upload(screen.getByLabelText("New file"), pdf("updated.pdf"));
    await user.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(screen.getByText("Updated CV")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Grad CV")).toBeNull();
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

    await user.click(await screen.findByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("New label")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New label")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Replace" }),
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

    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await user.upload(screen.getByLabelText("New file"), pdf("updated.pdf"));
    await user.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(screen.getByText("Updated CV")).toBeInTheDocument(),
    );

    expect(await screen.findByText("Backend roles")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Backend roles" })).toHaveAttribute(
      "href",
      "/scouts/scout1/edit",
    );
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
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionsPage />);

    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await user.upload(screen.getByLabelText("New file"), pdf("updated.pdf"));
    await user.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(screen.getByText("Updated CV")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert", { name: /still used/i })).toBeNull();
  });
});
