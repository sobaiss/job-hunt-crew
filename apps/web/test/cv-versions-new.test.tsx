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

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
}

describe("NewCvVersionPage — storing the CV failed", () => {
  beforeEach(() => {
    replace.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it("says so when the network fails creating the CVVersion", async () => {
    importHandlers({ statuses: ["CONVERTED"] });
    server.use(http.post("/api/cv-versions", () => HttpResponse.error()));
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    expect(await screen.findByText("Connection problem.")).toBeInTheDocument();
    expect(closeLink()).toHaveAttribute("href", "/cv-versions");
  });

  it("says so, with the API's detail, when the server fails creating it", async () => {
    importHandlers({ statuses: ["CONVERTED"] });
    server.use(
      http.post("/api/cv-versions", () =>
        HttpResponse.json({ detail: "Database unavailable" }, { status: 500 }),
      ),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    expect(await screen.findByText("Server error.")).toBeInTheDocument();
    expect(screen.getByText("Database unavailable")).toBeInTheDocument();
  });

  it("says so when the bytes could not be sent, and retries on the same upload URL", async () => {
    const { events } = importHandlers({ statuses: ["CONVERTED"] });
    let puts = 0;
    server.use(
      http.put(UPLOAD_URL, () => {
        puts += 1;
        events.push("put");
        return new HttpResponse(null, { status: puts === 1 ? 500 : 200 });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    expect(
      await screen.findByText("Your CV could not be sent."),
    ).toBeInTheDocument();
    await user().click(
      screen.getByRole("button", { name: "Retry the import" }),
    );

    expect(
      await screen.findByText("CV imported and converted"),
    ).toBeInTheDocument();
    expect(events).toEqual(["create", "put", "put", "convert"]);
  });

  it("runs the whole create-then-upload again once the upload URL has expired", async () => {
    const { events } = importHandlers({ statuses: ["CONVERTED"] });
    let puts = 0;
    server.use(
      http.put(UPLOAD_URL, () => {
        puts += 1;
        events.push("put");
        return new HttpResponse(null, { status: puts === 1 ? 500 : 200 });
      }),
      http.delete("/api/cv-versions/cv9", () => {
        events.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();
    await screen.findByText("Your CV could not be sent.");

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await user().click(
      screen.getByRole("button", { name: "Retry the import" }),
    );

    await screen.findByText("CV imported and converted");
    expect(events.filter((e) => e === "create")).toHaveLength(2);
  });

  it("deletes the orphan CVVersion when the candidate closes the screen", async () => {
    importHandlers({ statuses: ["CONVERTED"] });
    let deleted: string | null = null;
    server.use(
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 500 })),
      http.delete("/api/cv-versions/:id", ({ params }) => {
        deleted = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();
    await screen.findByText("Your CV could not be sent.");

    await user().click(closeLink());

    await vi.waitFor(() => expect(deleted).toBe("cv9"));
  });

  it("swallows a failed orphan delete", async () => {
    importHandlers({ statuses: ["CONVERTED"] });
    let deletes = 0;
    server.use(
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 500 })),
      http.delete("/api/cv-versions/:id", () => {
        deletes += 1;
        return HttpResponse.json({ detail: "boom" }, { status: 500 });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();
    await screen.findByText("Your CV could not be sent.");

    await user().click(closeLink());

    await vi.waitFor(() => expect(deletes).toBe(1));
    expect(screen.queryByText("boom")).toBeNull();
  });
});

describe("NewCvVersionPage — converting the CV failed", () => {
  beforeEach(() => {
    replace.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  function failedConversion(error: string) {
    server.use(
      http.get("/api/cv-versions/cv9/markdown", () =>
        HttpResponse.json({
          conversionStatus: "FAILED",
          markdownContent: null,
          conversionError: error,
        }),
      ),
    );
  }

  it("shows the stored cause under the failure sentence, and keeps the CVVersion on close", async () => {
    importHandlers({ statuses: ["CONVERTED"] });
    failedConversion("no usable text layer");
    let deletes = 0;
    server.use(
      http.delete("/api/cv-versions/:id", () => {
        deletes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    expect(
      await screen.findByText("Your CV's conversion failed."),
    ).toBeInTheDocument();
    expect(screen.getByText("no usable text layer")).toBeInTheDocument();

    await user().click(closeLink());
    await vi.advanceTimersByTimeAsync(100);
    expect(deletes).toBe(0);
  });

  it("lands here, not in the storing failure, when the convert request itself fails", async () => {
    importHandlers({ statuses: ["CONVERTED"] });
    let deletes = 0;
    server.use(
      http.post("/api/cv-versions/cv9/convert", () =>
        HttpResponse.json({ detail: "Queue unavailable" }, { status: 500 }),
      ),
      http.delete("/api/cv-versions/:id", () => {
        deletes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();

    expect(
      await screen.findByText("Your CV's conversion failed."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Your CV could not be sent.")).toBeNull();

    await user().click(closeLink());
    await vi.advanceTimersByTimeAsync(100);
    expect(deletes).toBe(0);
  });

  it("retries the Conversion on the same CVVersion", async () => {
    const { events } = importHandlers({ statuses: ["CONVERTED"] });
    let converts = 0;
    server.use(
      http.post("/api/cv-versions/cv9/convert", () => {
        converts += 1;
        events.push("convert");
        return converts === 1
          ? HttpResponse.json({ detail: "Queue unavailable" }, { status: 500 })
          : HttpResponse.json({ conversionStatus: "PENDING" });
      }),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();
    await screen.findByText("Your CV's conversion failed.");

    await user().click(
      screen.getByRole("button", { name: "Retry the conversion" }),
    );

    expect(
      await screen.findByText("CV imported and converted"),
    ).toBeInTheDocument();
    expect(events).toEqual(["create", "put", "convert", "convert"]);
  });

  it("replaces the file, then follows the new CVVersion", async () => {
    const { events } = importHandlers({ statuses: ["CONVERTED"] });
    failedConversion("no usable text layer");
    let replaceBody: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/cv-versions/cv9/replace", async ({ request }) => {
        replaceBody = (await request.json()) as Record<string, unknown>;
        events.push("replace");
        return HttpResponse.json(
          { cvVersionId: "cv10", fileKey: "k2", uploadUrl: UPLOAD_URL },
          { status: 201 },
        );
      }),
      http.post("/api/cv-versions/cv10/convert", () => {
        events.push("convert cv10");
        return HttpResponse.json({ conversionStatus: "PENDING" });
      }),
      http.get("/api/cv-versions/cv10/markdown", () =>
        HttpResponse.json({
          conversionStatus: "CONVERTED",
          markdownContent: "# Replaced CV",
          conversionError: null,
        }),
      ),
    );
    renderWithProviders(<NewCvVersionPage />);
    await submitImport();
    await screen.findByText("Your CV's conversion failed.");

    await user().upload(
      screen.getByLabelText("Replace the file"),
      pdf("fixed.pdf"),
    );

    expect(
      await screen.findByRole("heading", { name: "Replaced CV" }),
    ).toBeInTheDocument();
    expect(replaceBody).toMatchObject({
      label: "Fintech CV",
      fileName: "fixed.pdf",
    });
    expect(events).toEqual([
      "create",
      "put",
      "convert",
      "replace",
      "put",
      "convert cv10",
    ]);
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/cv-versions/cv10/edit",
    );
  });
});
