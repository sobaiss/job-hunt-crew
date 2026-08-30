import { describe, expect, it } from "vitest";

import { renderWithProviders, screen } from "./test-utils";
import { useEnumLabel } from "@/lib/enum-labels";

function StatusProbe({ value }: { value: string }) {
  const label = useEnumLabel("analysisStatus");
  return <span data-testid="label">{label(value)}</span>;
}

describe("useEnumLabel", () => {
  it("maps a known enum value to its localised label", () => {
    renderWithProviders(<StatusProbe value="COMPLETED" />, { locale: "fr" });
    expect(screen.getByTestId("label")).toHaveTextContent("Terminée");
  });

  it("falls back to the raw value for an unmapped enum member", () => {
    renderWithProviders(<StatusProbe value="SOME_NEW_STATUS" />, {
      locale: "fr",
    });
    expect(screen.getByTestId("label")).toHaveTextContent("SOME_NEW_STATUS");
  });
});
