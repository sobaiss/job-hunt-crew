import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("NewCvVersionPage — upload form", () => {
  beforeEach(() => replace.mockClear());

  it("shows inline validation when submitting with no label and no file", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewCvVersionPage />);

    await user.click(screen.getByRole("button", { name: "Upload" }));

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
    await user.click(screen.getByRole("button", { name: "Upload" }));

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
    await user.click(screen.getByRole("button", { name: "Upload" }));

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
    await user.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText("That file is larger than the 10 MB limit."),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("creates the CV version, PUTs the file, and redirects to /cv-versions", async () => {
    let createBody: Record<string, unknown> | null = null;
    let putReceived = false;
    server.use(
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
    renderWithProviders(<NewCvVersionPage />);

    await user.type(screen.getByLabelText("Label"), "Fintech CV");
    await user.upload(screen.getByLabelText("File"), pdf("fintech.pdf"));
    await user.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(putReceived).toBe(true));
    expect(createBody).toMatchObject({
      label: "Fintech CV",
      fileName: "fintech.pdf",
      contentType: "application/pdf",
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/cv-versions"));
  });
});
