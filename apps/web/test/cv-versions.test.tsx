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
    parseStatus: "PARSED",
    conversionStatus: "CONVERTED",
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
  it("renders each CV version with its parse status", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({
          cvVersions: [cvVersion({ parseStatus: "PARSING" })],
        }),
      ),
    );
    renderWithProviders(<CvVersionsPage />);

    expect(await screen.findByText("Grad CV")).toBeInTheDocument();
    expect(screen.getByText("Parsing")).toBeInTheDocument();
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
});
