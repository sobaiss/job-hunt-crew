import { describe, expect, it } from "vitest";

import {
  defaultColumnVisibility,
  resetColumnVisibility,
  toggleColumn,
  type ColumnConfig,
} from "@/lib/column-visibility";

type Key = "title" | "company" | "location" | "score";

const COLUMNS: ColumnConfig<Key>[] = [
  { key: "title", labelKey: "columns.title", hideable: false },
  { key: "company", labelKey: "columns.company", hideable: true },
  { key: "location", labelKey: "columns.location", hideable: true },
  { key: "score", labelKey: "columns.score", hideable: true },
];

describe("defaultColumnVisibility", () => {
  it("marks every hideable column visible by default", () => {
    expect(defaultColumnVisibility(COLUMNS)).toEqual({
      company: true,
      location: true,
      score: true,
    });
  });

  it("omits non-hideable columns from the state entirely", () => {
    expect(defaultColumnVisibility(COLUMNS)).not.toHaveProperty("title");
  });
});

describe("toggleColumn", () => {
  it("flips a single column's visibility, leaving the others untouched", () => {
    const state = defaultColumnVisibility(COLUMNS);
    const next = toggleColumn(state, "location");
    expect(next).toEqual({ company: true, location: false, score: true });
  });

  it("flips back to visible when toggled twice", () => {
    const state = defaultColumnVisibility(COLUMNS);
    const next = toggleColumn(toggleColumn(state, "score"), "score");
    expect(next).toEqual(state);
  });
});

describe("resetColumnVisibility", () => {
  it("restores every hideable column to visible regardless of prior state", () => {
    const afterCompany = toggleColumn<Key>(
      defaultColumnVisibility(COLUMNS),
      "company",
    );
    const state = toggleColumn<Key>(afterCompany, "score");
    expect(resetColumnVisibility(COLUMNS)).toEqual(
      defaultColumnVisibility(COLUMNS),
    );
    expect(state).not.toEqual(resetColumnVisibility(COLUMNS));
  });
});
