import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { server } from "./msw/server";
import NewCvVersionPage from "@/app/(app)/cv-versions/new/page";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

const UPLOAD_URL = "https://uploads.example.test/put";

function pdf(name = "cv.pdf", { size }: { size?: number } = {}) {
  const file = new File(["%PDF-1.4"], name, { type: "application/pdf" });
  if (size !== undefined) {
    Object.defineProperty(file, "size", { value: size });
  }
  return file;
}

describe("NewCvVersionPage — Import form", () => {
  beforeEach(() => replace.mockClear());

  it("shows inline validation when submitting with no label and no file", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewCvVersionPage />);

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByText("Give this CV version a label."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose a PDF, DOCX, Markdown, or plain-text file."),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file type with a type message", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewCvVersionPage />);

    await user.type(screen.getByLabelText("Label"), "My CV");
    await user.upload(
      screen.getByLabelText("File"),
      new File(["hi"], "notes.pdf", { type: "application/rtf" }),
    );
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByText(
        "Only PDF, DOCX, Markdown, and plain-text files are supported.",
      ),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("accepts a Markdown file", async () => {
    let createBody: Record<string, unknown> | null = null;
    server.use(
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
    renderWithProviders(<NewCvVersionPage />);

    await user.type(screen.getByLabelText("Label"), "Markdown CV");
    await user.upload(
      screen.getByLabelText("File"),
      new File(["# CV"], "cv.md", { type: "text/markdown" }),
    );
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({
      fileName: "cv.md",
      contentType: "text/markdown",
    });
  });

  it("rejects a file over the 10 MB limit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewCvVersionPage />);

    await user.type(screen.getByLabelText("Label"), "My CV");
    await user.upload(
      screen.getByLabelText("File"),
      pdf("big.pdf", { size: 11 * 1024 * 1024 }),
    );
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByText("That file is larger than the 10 MB limit."),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

type ConversionStatus = "PENDING" | "CONVERTING" | "CONVERTED" | "FAILED";

/**
 * The whole Import on the BFF: create, PUT, convert, then the per-CV
 * rendition endpoint answering `statuses` in turn (the last one repeats).
 * `events` records the order the requests arrived in.
 */
function importHandlers({
  statuses,
  isDefault = false,
}: {
  statuses: ConversionStatus[];
  isDefault?: boolean;
}) {
  const events: string[] = [];
  let polls = 0;
  server.use(
    http.post("/api/cv-versions", () => {
      events.push("create");
      return HttpResponse.json(
        { cvVersionId: "cv9", fileKey: "k", uploadUrl: UPLOAD_URL },
        { status: 201 },
      );
    }),
    http.put(UPLOAD_URL, () => {
      events.push("put");
      return new HttpResponse(null, { status: 200 });
    }),
    http.post("/api/cv-versions/cv9/convert", () => {
      events.push("convert");
      return HttpResponse.json({ conversionStatus: "PENDING" });
    }),
    http.get("/api/cv-versions/cv9/markdown", () => {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return HttpResponse.json({
        conversionStatus: status,
        markdownContent:
          status === "CONVERTED" ? "# Staff Engineer\n\nSince 2019" : null,
      });
    }),
    http.get("/api/cv-versions", () =>
      HttpResponse.json({
        cvVersions: [
          {
            id: "cv9",
            label: "Fintech CV",
            fileName: "fintech.pdf",
            fileType: "PDF",
            fileSizeBytes: 8,
            isDefault,
            conversionStatus: "CONVERTED",
            conversionError: null,
            supersededById: null,
            createdAt: "2026-09-22T10:00:00Z",
            updatedAt: "2026-09-22T10:00:00Z",
          },
        ],
      }),
    ),
  );
  return { events, polls: () => polls };
}

async function submitImport() {
  const user = userEvent.setup({
    advanceTimers: vi.advanceTimersByTime.bind(vi),
  });
  await user.type(screen.getByLabelText("Label"), "Fintech CV");
  await user.upload(screen.getByLabelText("File"), pdf("fintech.pdf"));
  await user.click(screen.getByRole("button", { name: "Import" }));
}

function closeLink() {
  return screen.getByRole("link", { name: "Close" });
}

describe("NewCvVersionPage — the Import in place", () => {
  beforeEach(() => {
    replace.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it("uploads, converts, then shows the CV in place without navigating away", async () => {
    const { events, polls } = importHandlers({
      statuses: ["CONVERTING", "CONVERTED"],
    });
    renderWithProviders(<NewCvVersionPage />);
    expect(closeLink()).toHaveAttribute("href", "/cv-versions");

    await submitImport();

    // Progress state: file uploaded, Conversion running, skeleton in the frame.
    const steps = await screen.findByRole("list", { name: "Import progress" });
    expect(steps).toHaveTextContent("File uploaded");
    expect(steps).toHaveTextContent("Converting…");
    expect(steps).toHaveTextContent("Ready");
    expect(
      await screen.findByLabelText("Converting your CV"),
    ).toBeInTheDocument();
    expect(closeLink()).toHaveAttribute("href", "/cv-versions");

    // The Conversion is started after the PUT, never before.
    await vi.waitFor(() =>
      expect(events).toEqual(["create", "put", "convert"]),
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect(
      await screen.findByText("CV imported and converted"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Staff Engineer" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Import progress" })).toBeNull();
    expect(screen.queryByLabelText("Converting your CV")).toBeNull();
    expect(
      screen.getByText(/Identifying information .* was removed/),
    ).toBeInTheDocument();
    expect(closeLink()).toHaveAttribute("href", "/cv-versions");
    expect(replace).not.toHaveBeenCalled();

    // Polling stops on a terminal status.
    const pollsAtTerminal = polls();
    await vi.advanceTimersByTimeAsync(10000);
    expect(polls()).toBe(pollsAtTerminal);
  });

  it("offers finish, edit, and set-as-default once converted", async () => {
    let setDefaultBody: unknown = null;
    importHandlers({ statuses: ["CONVERTED"] });
    server.use(
      http.patch("/api/cv-versions/cv9", async ({ request }) => {
        setDefaultBody = await request.json();
        return HttpResponse.json({ cvVersion: {} });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    await screen.findByText("CV imported and converted");
    expect(screen.getByRole("link", { name: "Finish" })).toHaveAttribute(
      "href",
      "/cv-versions",
    );
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/cv-versions/cv9/edit",
    );
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime.bind(vi),
    });
    await user.click(
      await screen.findByRole("button", { name: "Set as default" }),
    );
    await vi.waitFor(() => expect(setDefaultBody).toEqual({ isDefault: true }));
  });

  it("hides set-as-default when the imported CV is already the default", async () => {
    importHandlers({ statuses: ["CONVERTED"], isDefault: true });
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    await screen.findByText("CV imported and converted");
    await screen.findByRole("link", { name: "Edit" });
    expect(screen.queryByRole("button", { name: "Set as default" })).toBeNull();
  });
});
