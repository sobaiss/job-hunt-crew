import { describe, expect, it } from "vitest";

import {
  ANALYSES_PAGE_SIZES,
  DEFAULT_ANALYSES_FILTERS,
  DEFAULT_ANALYSES_SORT,
  analysesTableStateToParams,
  cvLabelsOf,
  filterAnalyses,
  pageCount,
  paginate,
  parseAnalysesTableState,
  sortAnalyses,
  type AnalysesTableState,
} from "@/lib/analyses-filters";
import type { AnalysisSummary } from "@/hooks/use-analyses";

function summary(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    cvVersionId: "cv1",
    ingestionJobId: null,
    scoutId: null,
    ingestionJob: null,
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme Inc",
      sourceSite: "FRANCE_TRAVAIL",
      postedAt: "2026-07-01T00:00:00.000Z",
      sourceUrl: "https://example.com/jobs/job1",
    },
    cvVersion: { label: "Grad CV" },
    ...overrides,
  };
}

describe("filterAnalyses", () => {
  const list = [
    summary({ id: "a1" }),
    summary({
      id: "a2",
      status: "FAILED",
      jobOffer: {
        id: "job2",
        title: "Frontend Dev",
        company: "Globex",
        sourceSite: "LINKEDIN",
        postedAt: "2026-07-02T00:00:00.000Z",
        sourceUrl: "https://example.com/jobs/job2",
      },
      cvVersion: { label: "Senior CV" },
    }),
    summary({
      id: "a3",
      status: "RUNNING_CREW",
      jobOffer: {
        id: "job3",
        title: "Platform Engineer",
        company: "Acme Inc",
        sourceSite: "WTTJ",
        postedAt: "2026-07-03T00:00:00.000Z",
        sourceUrl: "https://example.com/jobs/job3",
      },
      cvVersion: { label: "Grad CV" },
    }),
  ];

  it("returns everything with the default filters", () => {
    expect(filterAnalyses(list, DEFAULT_ANALYSES_FILTERS)).toEqual(list);
  });

  it("matches the search term against the offer title and company, case-insensitively", () => {
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        search: "acme",
      }).map((a) => a.id),
    ).toEqual(["a1", "a3"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        search: "frontend",
      }).map((a) => a.id),
    ).toEqual(["a2"]);
  });

  it("filters by status and by CVVersion label, and combines the two", () => {
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        status: "FAILED",
      }).map((a) => a.id),
    ).toEqual(["a2"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        cvLabel: "Grad CV",
      }).map((a) => a.id),
    ).toEqual(["a1", "a3"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        cvLabel: "Grad CV",
        status: "RUNNING_CREW",
      }).map((a) => a.id),
    ).toEqual(["a3"]);
  });
});

describe("cvLabelsOf", () => {
  it("lists the distinct labels in first-seen order", () => {
    expect(
      cvLabelsOf([
        summary({ cvVersion: { label: "Grad CV" } }),
        summary({ cvVersion: { label: "Senior CV" } }),
        summary({ cvVersion: { label: "Grad CV" } }),
      ]),
    ).toEqual(["Grad CV", "Senior CV"]);
  });
});

describe("sortAnalyses", () => {
  it("sorts strings ascending/descending by localeCompare", () => {
    const list = [
      summary({ id: "b", jobOffer: { ...summary().jobOffer, title: "Beta" } }),
      summary({ id: "a", jobOffer: { ...summary().jobOffer, title: "Alpha" } }),
    ];

    expect(
      sortAnalyses(list, { column: "title", direction: "asc" }).map((a) => a.id),
    ).toEqual(["a", "b"]);
    expect(
      sortAnalyses(list, { column: "title", direction: "desc" }).map((a) => a.id),
    ).toEqual(["b", "a"]);
  });

  it("sorts numbers, and always sorts a null value last regardless of direction", () => {
    const list = [
      summary({ id: "mid", matchScore: 50 }),
      summary({ id: "none", matchScore: null }),
      summary({ id: "high", matchScore: 90 }),
    ];

    expect(
      sortAnalyses(list, { column: "matchScore", direction: "asc" }).map(
        (a) => a.id,
      ),
    ).toEqual(["mid", "high", "none"]);
    expect(
      sortAnalyses(list, { column: "matchScore", direction: "desc" }).map(
        (a) => a.id,
      ),
    ).toEqual(["high", "mid", "none"]);
  });

  it("compares postedAt as ISO-8601 UTC strings without needing Date parsing", () => {
    const list = [
      summary({
        id: "later",
        jobOffer: { ...summary().jobOffer, postedAt: "2026-08-01T00:00:00.000Z" },
      }),
      summary({
        id: "earlier",
        jobOffer: { ...summary().jobOffer, postedAt: "2026-07-01T00:00:00.000Z" },
      }),
    ];

    expect(
      sortAnalyses(list, DEFAULT_ANALYSES_SORT).map((a) => a.id),
    ).toEqual(["later", "earlier"]);
  });

  it("sorts by sourceUrl for the Lien column and by cvVersion.label for CV", () => {
    const list = [
      summary({ id: "z", jobOffer: { ...summary().jobOffer, sourceUrl: "https://z.example.com" } }),
      summary({ id: "a", jobOffer: { ...summary().jobOffer, sourceUrl: "https://a.example.com" } }),
    ];
    expect(
      sortAnalyses(list, { column: "sourceUrl", direction: "asc" }).map((a) => a.id),
    ).toEqual(["a", "z"]);

    const byCv = [
      summary({ id: "s", cvVersion: { label: "Senior CV" } }),
      summary({ id: "g", cvVersion: { label: "Grad CV" } }),
    ];
    expect(
      sortAnalyses(byCv, { column: "cvLabel", direction: "asc" }).map((a) => a.id),
    ).toEqual(["g", "s"]);
  });
});

describe("pagination", () => {
  const items = Array.from({ length: 12 }, (_, i) => i);

  it("computes page count and slices one page at a time", () => {
    expect(pageCount(12, 5)).toBe(3);
    expect(pageCount(0, 5)).toBe(1);
    expect(paginate(items, 1, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(paginate(items, 3, 5)).toEqual([10, 11]);
  });

  it("exposes exactly the two supported page sizes", () => {
    expect(ANALYSES_PAGE_SIZES).toEqual([25, 50]);
  });
});

describe("URL query-string state", () => {
  it("round-trips a fully-specified state through params and back", () => {
    const state: AnalysesTableState = {
      search: "backend",
      status: "FAILED",
      cvLabel: "Grad CV",
      sort: { column: "matchScore", direction: "asc" },
      page: 2,
      pageSize: 50,
    };

    const params = analysesTableStateToParams(state);
    expect(parseAnalysesTableState(params)).toEqual(state);
  });

  it("falls back to defaults for a missing or invalid query string", () => {
    expect(parseAnalysesTableState(new URLSearchParams())).toEqual({
      search: "",
      status: "all",
      cvLabel: "all",
      sort: DEFAULT_ANALYSES_SORT,
      page: 1,
      pageSize: 25,
    });

    expect(
      parseAnalysesTableState(
        new URLSearchParams("status=NOT_A_STATUS&sort=bogus&dir=sideways&page=-1&pageSize=999"),
      ),
    ).toEqual({
      search: "",
      status: "all",
      cvLabel: "all",
      sort: DEFAULT_ANALYSES_SORT,
      page: 1,
      pageSize: 25,
    });
  });

  it("omits a param from the query string when it's the default", () => {
    const params = analysesTableStateToParams({
      search: "",
      status: "all",
      cvLabel: "all",
      sort: DEFAULT_ANALYSES_SORT,
      page: 1,
      pageSize: 25,
    });
    expect(params.has("q")).toBe(false);
    expect(params.has("status")).toBe(false);
    expect(params.has("cv")).toBe(false);
    // Sort, page and pageSize are always written explicitly.
    expect(params.get("sort")).toBe("postedAt");
    expect(params.get("dir")).toBe("desc");
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("25");
  });
});
