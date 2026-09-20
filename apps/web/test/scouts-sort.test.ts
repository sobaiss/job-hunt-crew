import { describe, expect, it } from "vitest";

import { DEFAULT_SCOUTS_SORT, sortScouts } from "@/lib/scouts-sort";
import type { Scout } from "@/hooks/use-scouts";

function scout(overrides: Partial<Scout> = {}): Scout {
  return {
    id: "scout1",
    userId: "user1",
    label: "Senior Backend",
    cvVersionId: "cv1",
    targetSiteKeys: ["FRANCE_TRAVAIL"],
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
    lastRunAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    relevantFindsCount: 0,
    ...overrides,
  };
}

describe("sortScouts", () => {
  it("sorts the label column ascending/descending by localeCompare", () => {
    const list = [
      scout({ id: "b", label: "Beta Scout" }),
      scout({ id: "a", label: "Alpha Scout" }),
    ];

    expect(
      sortScouts(list, { column: "label", direction: "asc" }).map((s) => s.id),
    ).toEqual(["a", "b"]);
    expect(
      sortScouts(list, { column: "label", direction: "desc" }).map((s) => s.id),
    ).toEqual(["b", "a"]);
  });

  it("sorts the id column alphabetically", () => {
    const list = [
      scout({ id: "scout-b" }),
      scout({ id: "scout-a" }),
    ];

    expect(
      sortScouts(list, { column: "id", direction: "asc" }).map((s) => s.id),
    ).toEqual(["scout-a", "scout-b"]);
  });

  it("sorts the status column alphabetically", () => {
    const list = [
      scout({ id: "active", status: "ACTIVE" }),
      scout({ id: "archived", status: "ARCHIVED" }),
      scout({ id: "paused", status: "PAUSED" }),
    ];

    expect(
      sortScouts(list, { column: "status", direction: "asc" }).map((s) => s.id),
    ).toEqual(["active", "archived", "paused"]);
  });

  it("sorts the baseCv column by the resolved CVVersion label, not the raw id", () => {
    const list = [
      scout({ id: "z", cvVersionId: "cv-z" }),
      scout({ id: "a", cvVersionId: "cv-a" }),
    ];
    const cvLabelById = new Map([
      ["cv-z", "Alpha CV"],
      ["cv-a", "Zebra CV"],
    ]);

    expect(
      sortScouts(list, { column: "baseCv", direction: "asc" }, cvLabelById).map(
        (s) => s.id,
      ),
    ).toEqual(["z", "a"]);
  });

  it("sorts the sites column by target site count", () => {
    const list = [
      scout({ id: "many", targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN", "INDEED"] }),
      scout({ id: "few", targetSiteKeys: ["FRANCE_TRAVAIL"] }),
    ];

    expect(
      sortScouts(list, { column: "sites", direction: "asc" }).map((s) => s.id),
    ).toEqual(["few", "many"]);
    expect(
      sortScouts(list, { column: "sites", direction: "desc" }).map((s) => s.id),
    ).toEqual(["many", "few"]);
  });

  it("sorts the relevantFinds column numerically", () => {
    const list = [
      scout({ id: "high", relevantFindsCount: 9 }),
      scout({ id: "low", relevantFindsCount: 1 }),
    ];

    expect(
      sortScouts(list, { column: "relevantFinds", direction: "desc" }).map(
        (s) => s.id,
      ),
    ).toEqual(["high", "low"]);
  });

  it("sorts the lastRun column as ISO-8601 strings, newest first by default", () => {
    const list = [
      scout({ id: "earlier", lastRunAt: "2026-07-01T00:00:00.000Z" }),
      scout({ id: "later", lastRunAt: "2026-08-01T00:00:00.000Z" }),
    ];

    expect(sortScouts(list, DEFAULT_SCOUTS_SORT).map((s) => s.id)).toEqual([
      "later",
      "earlier",
    ]);
  });

  it("always sorts a Scout that has never run last, regardless of direction", () => {
    const list = [
      scout({ id: "never", lastRunAt: null }),
      scout({ id: "ran", lastRunAt: "2026-08-01T00:00:00.000Z" }),
    ];

    expect(
      sortScouts(list, { column: "lastRun", direction: "asc" }).map((s) => s.id),
    ).toEqual(["ran", "never"]);
    expect(
      sortScouts(list, { column: "lastRun", direction: "desc" }).map((s) => s.id),
    ).toEqual(["ran", "never"]);
  });
});
