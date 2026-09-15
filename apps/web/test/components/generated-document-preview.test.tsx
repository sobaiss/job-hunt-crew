import { describe, expect, it } from "vitest";

import { renderWithProviders, screen } from "../test-utils";
import { GeneratedDocumentPreview } from "@/components/generated-document-preview";

describe("GeneratedDocumentPreview", () => {
  it("renders #/##/### as real headings", () => {
    renderWithProviders(
      <GeneratedDocumentPreview markdown={"# Title\n\n## Section\n\n### Sub-section"} />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Section" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Sub-section" })).toBeInTheDocument();
  });

  it("renders -/* bullets as real list items", () => {
    renderWithProviders(<GeneratedDocumentPreview markdown={"- First\n* Second"} />);

    const list = screen.getByRole("list");
    const items = screen.getAllByRole("listitem");
    expect(list).toBeInTheDocument();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("First");
    expect(items[1]).toHaveTextContent("Second");
  });

  it("renders inline **bold**/*italic* as real emphasis", () => {
    renderWithProviders(<GeneratedDocumentPreview markdown="Some **bold** and *italic* text." />);

    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
  });

  it("renders --- as a horizontal rule", () => {
    renderWithProviders(<GeneratedDocumentPreview markdown={"Above\n\n---\n\nBelow"} />);

    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("never shows the SectionType marker", () => {
    renderWithProviders(
      <GeneratedDocumentPreview
        markdown={"## Experience\n<!-- SectionType: EXPERIENCE -->\n\nDid things."}
      />,
    );

    expect(screen.queryByText(/SectionType/)).not.toBeInTheDocument();
  });

  it("renders an unsupported construct as plain text instead of breaking", () => {
    renderWithProviders(
      <GeneratedDocumentPreview markdown="[a link](https://example.com) | table | cell" />,
    );

    expect(screen.getByText(/\[a link\]\(https:\/\/example\.com\)/)).toBeInTheDocument();
  });
});
