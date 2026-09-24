import { describe, expect, it } from "vitest";

import {
  ANALYSES_PAGE_SIZES,
  DEFAULT_ANALYSES_FILTERS,
  DEFAULT_ANALYSES_SORT,
  DEFAULT_ANALYSES_TABLE_STATE,
  JOB_OFFER_SOURCE_SITES,
  activeAdvancedFilterCount,
  analysesTableStateToParams,
  analysesTableStateToQuery,
  hasActiveFilters,
  pageCount,
  parseAnalysesTableState,
  type AnalysesTableState,
} from "@/lib/analyses-filters";
import { ANALYSES_STATUS_FILTERS } from "@/lib/tracking-status";

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

describe("pagination", () => {
  it("computes how many pages a total covers", () => {
    expect(pageCount(12, 5)).toBe(3);
    expect(pageCount(0, 5)).toBe(1);
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

  it("rejects a raw pipeline AnalysisStatus other than PENDING or FAILED as a status param", () => {
    expect(
      parseAnalysesTableState(new URLSearchParams("status=RUNNING_CREW")).status,
    ).toEqual([]);
  });

  it("accepts exactly the 5 Tracking status buckets plus PENDING and FAILED as the status param", () => {
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

describe("analysesTableStateToQuery", () => {
  // What the browser's URL carries and what the endpoint is asked for are two
  // different query strings: the first is a shareable link, the second a
  // request. This is the second one.
  const state: AnalysesTableState = {
    search: "  backend  ",
    status: ["REJECTED", "PENDING"],
    cvLabel: "Grad CV",
    platform: ["LINKEDIN", "INDEED"],
    location: "  lyon ",
    requestedAtFrom: "2026-07-01",
    requestedAtTo: "2026-07-31",
    sort: { column: "matchScore", direction: "asc" },
    page: 2,
    pageSize: 50,
  };

  it("spells out every filter under the endpoint's own parameter names", () => {
    const query = analysesTableStateToQuery(state);
    expect(query.get("q")).toBe("backend");
    expect(query.get("status")).toBe("REJECTED,PENDING");
    expect(query.get("cv")).toBe("Grad CV");
    expect(query.get("platform")).toBe("LINKEDIN,INDEED");
    expect(query.get("location")).toBe("lyon");
    expect(query.get("sort")).toBe("matchScore");
    expect(query.get("dir")).toBe("asc");
    expect(query.get("page")).toBe("2");
    expect(query.get("pageSize")).toBe("50");
  });

  it("widens each date bound to cover the whole named day", () => {
    // The date input gives a bare YYYY-MM-DD; the endpoint takes timestamps,
    // and a bare date would exclude everything requested later that day.
    const query = analysesTableStateToQuery(state);
    expect(query.get("requestedAtFrom")).toBe("2026-07-01T00:00:00.000Z");
    expect(query.get("requestedAtTo")).toBe("2026-07-31T23:59:59.999Z");
  });

  it("sends no filter at all for the default state", () => {
    const query = analysesTableStateToQuery(DEFAULT_ANALYSES_TABLE_STATE);
    for (const name of ["q", "status", "cv", "platform", "location", "requestedAtFrom", "requestedAtTo"]) {
      expect(query.has(name)).toBe(false);
    }
    // The sort and the page are never left to the endpoint's own defaults:
    // the table's default sort (postedAt) and the endpoint's would then be two
    // facts to keep in step.
    expect(query.get("sort")).toBe("postedAt");
    expect(query.get("page")).toBe("1");
    expect(query.get("pageSize")).toBe("25");
  });

  it("gives the same query for two states that differ only in whitespace", () => {
    // Otherwise every trailing space typed into the search box is its own
    // cache entry and its own request for identical results.
    expect(analysesTableStateToQuery(state).toString()).toBe(
      analysesTableStateToQuery({ ...state, search: "backend", location: "lyon" }).toString(),
    );
  });
});
