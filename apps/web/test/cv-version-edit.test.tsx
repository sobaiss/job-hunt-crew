import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor } from "./test-utils";
import { server } from "./msw/server";
import CvVersionEditPage from "@/app/(app)/cv-versions/[id]/edit/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "cv1" }),
}));

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

const RAW_MARKDOWN = "# Jane Doe\n\n- Staff Engineer\n- 5 years experience";

function mockList(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("/api/cv-versions", () =>
      HttpResponse.json({ cvVersions: [cvVersion(overrides)] }),
    ),
  );
}

function mockMarkdown(content: string) {
  server.use(
    http.get("/api/cv-versions/cv1/markdown", () =>
      HttpResponse.json({ markdownContent: content, conversionStatus: "CONVERTED" }),
    ),
  );
}

describe("CvVersionEditPage", () => {
  it("renders the rendition as real HTML structure, not raw Markdown text", async () => {
    mockList();
    mockMarkdown(RAW_MARKDOWN);
    renderWithProviders(<CvVersionEditPage />);

    expect(
      await screen.findByRole("heading", { name: "Jane Doe", level: 1 }),
    ).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toContain("Staff Engineer");
    expect(screen.queryByText(RAW_MARKDOWN)).toBeNull();
  });

  it("does not render the editor for a superseded CV version", async () => {
    mockList({ supersededById: "cv2" });
    mockMarkdown(RAW_MARKDOWN);
    renderWithProviders(<CvVersionEditPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "isn't available to edit",
    );
    expect(screen.queryByRole("button", { name: "Modifier" })).toBeNull();
  });

  it("does not render the editor for a CV version that isn't yet converted", async () => {
    mockList({ conversionStatus: "PENDING" });
    renderWithProviders(<CvVersionEditPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "isn't available to edit",
    );
  });

  it("'Modifier' opens a text editor pre-filled with the raw Markdown", async () => {
    mockList();
    mockMarkdown(RAW_MARKDOWN);
    const user = userEvent.setup();
    renderWithProviders(<CvVersionEditPage />);

    await user.click(await screen.findByRole("button", { name: "Modifier" }));

    expect(screen.getByRole("textbox")).toHaveValue(RAW_MARKDOWN);
  });

  it("'Annuler' discards typed changes, returns to view mode, and fires no save request", async () => {
    let putRequests = 0;
    mockList();
    mockMarkdown(RAW_MARKDOWN);
    server.use(
      http.put("/api/cv-versions/cv1/markdown", () => {
        putRequests += 1;
        return HttpResponse.json({ markdownContent: "x", conversionStatus: "CONVERTED" });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionEditPage />);

    await user.click(await screen.findByRole("button", { name: "Modifier" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "something else entirely");
    await user.click(screen.getByRole("button", { name: "Annuler" }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Jane Doe" })).toBeInTheDocument();
    expect(putRequests).toBe(0);
  });

  it("blocks saving when the editor content is empty or whitespace-only", async () => {
    mockList();
    mockMarkdown(RAW_MARKDOWN);
    const user = userEvent.setup();
    renderWithProviders(<CvVersionEditPage />);

    await user.click(await screen.findByRole("button", { name: "Modifier" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "   ");

    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  });

  it("requires the inline confirm step before any save request fires", async () => {
    let putRequests = 0;
    mockList();
    mockMarkdown(RAW_MARKDOWN);
    server.use(
      http.put("/api/cv-versions/cv1/markdown", () => {
        putRequests += 1;
        return HttpResponse.json({
          markdownContent: "# Updated",
          conversionStatus: "CONVERTED",
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionEditPage />);

    await user.click(await screen.findByRole("button", { name: "Modifier" }));
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(putRequests).toBe(0);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(putRequests).toBe(1));
  });

  it("a successful save returns to view mode showing the freshly saved content", async () => {
    let storedContent = RAW_MARKDOWN;
    mockList();
    server.use(
      http.get("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ markdownContent: storedContent, conversionStatus: "CONVERTED" }),
      ),
      http.put("/api/cv-versions/cv1/markdown", async ({ request }) => {
        const body = (await request.json()) as { markdownContent: string };
        storedContent = body.markdownContent;
        return HttpResponse.json({
          markdownContent: storedContent,
          conversionStatus: "CONVERTED",
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionEditPage />);

    await user.click(await screen.findByRole("button", { name: "Modifier" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "# Updated Title");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByRole("heading", { name: "Updated Title" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a failed save keeps the typed text and shows an inline error", async () => {
    mockList();
    mockMarkdown(RAW_MARKDOWN);
    server.use(
      http.put("/api/cv-versions/cv1/markdown", () =>
        HttpResponse.json({ error: "Server error" }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<CvVersionEditPage />);

    await user.click(await screen.findByRole("button", { name: "Modifier" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "still typing this");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't save your changes",
    );
    expect(screen.getByRole("textbox")).toHaveValue("still typing this");
  });
});
