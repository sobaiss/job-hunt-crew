import { describe, expect, it } from "vitest";

import {
  ANALYSES_PAGE_SIZES,
  DEFAULT_ANALYSES_FILTERS,
  DEFAULT_ANALYSES_SORT,
  DEFAULT_ANALYSES_TABLE_STATE,
  JOB_OFFER_SOURCE_SITES,
  activeAdvancedFilterCount,
  analysesTableStateToParams,
  cvLabelsOf,
  filterAnalyses,
  hasActiveFilters,
  pageCount,
  paginate,
  parseAnalysesTableState,
  sortAnalyses,
  type AnalysesTableState,
} from "@/lib/analyses-filters";
import { ANALYSES_STATUS_FILTERS, TRACKING_STATUSES } from "@/lib/tracking-status";
import type { AnalysisSummary } from "@/hooks/use-analyses";

function summary(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
  return {
    id: "a1",
    status: "COMPLETED",
    matchScore: 80,
    requestedAt: "2026-08-01T00:00:00.000Z",
    requeuedAt: null,
    stuck: false,
    cvVersionId: "cv1",
    ingestionJobId: null,
    scoutId: null,
    applicationStatus: null,
    tailoredCvStatus: null,
    coverLetterStatus: null,
    ingestionJob: null,
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme Inc",
      location: "Paris",
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
    summary({ id: "a1" }), // COMPLETED, no Application yet -> TO_APPLY
    summary({
      id: "a2",
      status: "FAILED",
      jobOffer: {
        id: "job2",
        title: "Frontend Dev",
        company: "Globex",
        location: "Lyon",
        sourceSite: "LINKEDIN",
        postedAt: "2026-07-02T00:00:00.000Z",
        sourceUrl: "https://example.com/jobs/job2",
      },
      cvVersion: { label: "Senior CV" },
    }),
    summary({
      id: "a3",
      status: "COMPLETED",
      applicationStatus: "REJECTED",
      jobOffer: {
        id: "job3",
        title: "Platform Engineer",
        company: "Acme Inc",
        location: "Paris",
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

  it("filters by platform, and by location as a case-insensitive substring", () => {
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        platform: ["LINKEDIN"],
      }).map((a) => a.id),
    ).toEqual(["a2"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        location: "par",
      }).map((a) => a.id),
    ).toEqual(["a1", "a3"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        platform: ["FRANCE_TRAVAIL"],
        location: "par",
      }).map((a) => a.id),
    ).toEqual(["a1"]);
  });

  it("filters by Tracking status and by CVVersion label, and combines the two", () => {
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        status: ["TO_APPLY"],
      }).map((a) => a.id),
    ).toEqual(["a1"]);

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
        status: ["REJECTED"],
      }).map((a) => a.id),
    ).toEqual(["a3"]);
  });

  it("excludes a still-running Analysis from every status filter but \"all\" and every Tracking bucket, while FAILED gets its own bucket", () => {
    expect(
      filterAnalyses(list, DEFAULT_ANALYSES_FILTERS).map((a) => a.id),
    ).toContain("a2");

    for (const status of TRACKING_STATUSES) {
      expect(
        filterAnalyses(list, { ...DEFAULT_ANALYSES_FILTERS, status: [status] }).map(
          (a) => a.id,
        ),
      ).not.toContain("a2");
    }

    expect(
      filterAnalyses(list, { ...DEFAULT_ANALYSES_FILTERS, status: ["FAILED"] }).map(
        (a) => a.id,
      ),
    ).toEqual(["a2"]);
  });

  it("ORs the values inside one filter and ANDs the filters together", () => {
    // a1 is FRANCE_TRAVAIL/TO_APPLY, a2 LINKEDIN/FAILED, a3 WTTJ/REJECTED.
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        platform: ["LINKEDIN", "WTTJ"],
      }).map((a) => a.id),
    ).toEqual(["a2", "a3"]);

    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        status: ["TO_APPLY", "FAILED"],
      }).map((a) => a.id),
    ).toEqual(["a1", "a2"]);

    // Two statuses OR-ed, then AND-ed with a platform that only one of them
    // has — the intersection, not the union.
    expect(
      filterAnalyses(list, {
        ...DEFAULT_ANALYSES_FILTERS,
        status: ["TO_APPLY", "FAILED"],
        platform: ["LINKEDIN"],
      }).map((a) => a.id),
    ).toEqual(["a2"]);
  });

  it("filters by the requestedAt range, inclusive of both bounds", () => {
    const dated = [
      summary({ id: "early", requestedAt: "2026-07-01T00:00:00.000Z" }),
      summary({ id: "mid", requestedAt: "2026-07-15T12:00:00.000Z" }),
      summary({ id: "late", requestedAt: "2026-08-01T00:00:00.000Z" }),
    ];

    expect(
      filterAnalyses(dated, {
        ...DEFAULT_ANALYSES_FILTERS,
        requestedAtFrom: "2026-07-10",
        requestedAtTo: "2026-07-20",
      }).map((a) => a.id),
    ).toEqual(["mid"]);

    expect(
      filterAnalyses(dated, {
        ...DEFAULT_ANALYSES_FILTERS,
        requestedAtFrom: "2026-07-15",
      }).map((a) => a.id),
    ).toEqual(["mid", "late"]);

    expect(
      filterAnalyses(dated, {
        ...DEFAULT_ANALYSES_FILTERS,
        requestedAtTo: "2026-07-15",
      }).map((a) => a.id),
    ).toEqual(["early", "mid"]);
  });
});

describe("active filter counts", () => {
  it("counts only the filters folded away behind 'Plus de filtres'", () => {
    expect(activeAdvancedFilterCount(DEFAULT_ANALYSES_FILTERS)).toBe(0);
    // Search and status stay visible above the table, so neither counts.
    expect(
      activeAdvancedFilterCount({
        ...DEFAULT_ANALYSES_FILTERS,
        search: "backend",
        status: ["IN_PROGRESS"],
      }),
    ).toBe(0);
    expect(
      activeAdvancedFilterCount({
        ...DEFAULT_ANALYSES_FILTERS,
        platform: ["LINKEDIN"],
        location: "lyon",
        requestedAtFrom: "2026-08-01",
      }),
    ).toBe(3);
  });

  it("counts a multi-select filter once however many values it holds", () => {
    // The number answers "how much is hidden behind this closed panel", not
    // "how many boxes did I tick".
    expect(
      activeAdvancedFilterCount({
        ...DEFAULT_ANALYSES_FILTERS,
        platform: ["LINKEDIN", "INDEED", "WTTJ"],
      }),
    ).toBe(1);
  });

  it("reports any filter at all as active, visible or folded away", () => {
    expect(hasActiveFilters(DEFAULT_ANALYSES_FILTERS)).toBe(false);
    expect(
      hasActiveFilters({ ...DEFAULT_ANALYSES_FILTERS, search: "backend" }),
    ).toBe(true);
    expect(
      hasActiveFilters({ ...DEFAULT_ANALYSES_FILTERS, status: ["IN_PROGRESS"] }),
    ).toBe(true);
    expect(
      hasActiveFilters({ ...DEFAULT_ANALYSES_FILTERS, cvLabel: "Grad CV" }),
    ).toBe(true);
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

  it("sorts by requestedAt as ISO-8601 UTC strings, and by id (#172)", () => {
    const list = [
      summary({ id: "b", requestedAt: "2026-08-01T00:00:00.000Z" }),
      summary({ id: "a", requestedAt: "2026-07-01T00:00:00.000Z" }),
    ];

    expect(
      sortAnalyses(list, { column: "requestedAt", direction: "asc" }).map((a) => a.id),
    ).toEqual(["a", "b"]);
    expect(
      sortAnalyses(list, { column: "id", direction: "asc" }).map((a) => a.id),
    ).toEqual(["a", "b"]);
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
      status: ["REJECTED"],
      cvLabel: "Grad CV",
      platform: ["LINKEDIN"],
      location: "lyon",
      requestedAtFrom: "2026-07-01",
      requestedAtTo: "2026-07-31",
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
      status: [],
      cvLabel: "all",
      platform: [],
      location: "",
      requestedAtFrom: "",
      requestedAtTo: "",
      sort: DEFAULT_ANALYSES_SORT,
      page: 1,
      pageSize: 25,
    });

    expect(
      parseAnalysesTableState(
        new URLSearchParams(
          "status=NOT_A_STATUS&platform=NOT_A_PLATFORM&sort=bogus&dir=sideways&page=-1&pageSize=999",
        ),
      ),
    ).toEqual({
      search: "",
      status: [],
      cvLabel: "all",
      platform: [],
      location: "",
      requestedAtFrom: "",
      requestedAtTo: "",
      sort: DEFAULT_ANALYSES_SORT,
      page: 1,
      pageSize: 25,
    });
  });

  it("accepts exactly the 7 JobOfferSourceSite values as the platform param", () => {
    for (const platform of JOB_OFFER_SOURCE_SITES) {
      expect(
        parseAnalysesTableState(new URLSearchParams(`platform=${platform}`)).platform,
      ).toEqual([platform]);
    }
  });

  it("rejects a raw pipeline AnalysisStatus other than FAILED as a status param", () => {
    expect(
      parseAnalysesTableState(new URLSearchParams("status=RUNNING_CREW")).status,
    ).toEqual([]);
  });

  it("accepts exactly the 5 Tracking status buckets plus FAILED as the status param (#172)", () => {
    for (const status of ANALYSES_STATUS_FILTERS) {
      expect(
        parseAnalysesTableState(new URLSearchParams(`status=${status}`)).status,
      ).toEqual([status]);
    }
  });

  it("round-trips several values through one comma-separated param", () => {
    const params = analysesTableStateToParams({
      ...DEFAULT_ANALYSES_TABLE_STATE,
      status: ["TO_APPLY", "FAILED"],
      platform: ["LINKEDIN", "WTTJ"],
    });
    expect(params.get("status")).toBe("TO_APPLY,FAILED");
    expect(params.get("platform")).toBe("LINKEDIN,WTTJ");
    expect(parseAnalysesTableState(params).status).toEqual(["TO_APPLY", "FAILED"]);
    expect(parseAnalysesTableState(params).platform).toEqual(["LINKEDIN", "WTTJ"]);
  });

  it("keeps the values a multi-select param got right and drops the rest", () => {
    // A hand-edited or stale link narrows by what it can, rather than
    // crashing or falling back to no filter at all.
    expect(
      parseAnalysesTableState(new URLSearchParams("status=TO_APPLY,NOPE,FAILED"))
        .status,
    ).toEqual(["TO_APPLY", "FAILED"]);
    expect(
      parseAnalysesTableState(new URLSearchParams("platform=LINKEDIN,LINKEDIN"))
        .platform,
    ).toEqual(["LINKEDIN"]);
    expect(
      parseAnalysesTableState(new URLSearchParams("status=,")).status,
    ).toEqual([]);
  });

  it("still reads a single-value param, as every link minted before the filters went multiple carries", () => {
    expect(
      parseAnalysesTableState(
        new URLSearchParams("q=front&status=REJECTED&platform=INDEED"),
      ),
    ).toMatchObject({
      search: "front",
      status: ["REJECTED"],
      platform: ["INDEED"],
    });
  });

  it("omits a param from the query string when it's the default", () => {
    const params = analysesTableStateToParams({
      search: "",
      status: [],
      cvLabel: "all",
      platform: [],
      location: "",
      requestedAtFrom: "",
      requestedAtTo: "",
      sort: DEFAULT_ANALYSES_SORT,
      page: 1,
      pageSize: 25,
    });
    expect(params.has("q")).toBe(false);
    expect(params.has("status")).toBe(false);
    expect(params.has("cv")).toBe(false);
    expect(params.has("platform")).toBe(false);
    expect(params.has("location")).toBe(false);
    expect(params.has("requestedFrom")).toBe(false);
    expect(params.has("requestedTo")).toBe(false);
    // Sort, page and pageSize are always written explicitly.
    expect(params.get("sort")).toBe("postedAt");
    expect(params.get("dir")).toBe("desc");
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("25");
  });
});
