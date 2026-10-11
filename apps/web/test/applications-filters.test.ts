import { describe, expect, it } from "vitest";

import {
  APPLICATIONS_PAGE_SIZES,
  DEFAULT_APPLICATIONS_FILTERS,
  DEFAULT_APPLICATIONS_SORT,
  DEFAULT_APPLICATIONS_TABLE_STATE,
  activeAdvancedFilterCount,
  applicationsTableStateToParams,
  filterApplications,
  hasActiveFilters,
  pageCount,
  paginate,
  parseApplicationsTableState,
  sortApplications,
  type ApplicationSummary,
  type ApplicationsTableState,
} from "@/lib/applications-filters";
import { TRACKING_STATUSES } from "@/lib/tracking-status";

function summary(overrides: Partial<ApplicationSummary> = {}): ApplicationSummary {
  return {
    id: "app1",
    userId: "u1",
    analysisId: "an1",
    jobOfferId: "job1",
    cvVersionId: "cv1",
    scoutId: null,
    coverLetterDocId: null,
    tailoredCvDocId: null,
    status: "APPLIED",
    appliedAt: "2026-08-01T10:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    jobOffer: {
      id: "job1",
      title: "Backend Engineer",
      company: "Acme Inc",
      location: "Paris",
      sourceSite: "FRANCE_TRAVAIL",
    },
    cvVersion: { label: "Grad CV" },
    ...overrides,
  };
}

const list = [
  summary({ id: "app1", scoutId: "s1" }), // APPLIED -> IN_PROGRESS
  summary({
    id: "app2",
    status: "REJECTED",
    appliedAt: "2026-08-05T10:00:00.000Z",
    jobOffer: {
      id: "job2",
      title: "Frontend Dev",
      company: "Globex",
      location: "Lyon",
      sourceSite: "LINKEDIN",
    },
  }),
  summary({
    id: "app3",
    status: "DRAFT",
    appliedAt: null,
    scoutId: "s2",
    jobOffer: {
      id: "job3",
      title: "Platform Engineer",
      company: null,
      location: null,
      sourceSite: "WTTJ",
    },
  }),
];

const ids = (apps: ApplicationSummary[]) => apps.map((a) => a.id);

describe("filterApplications", () => {
  it("returns everything with the default filters", () => {
    expect(filterApplications(list, DEFAULT_APPLICATIONS_FILTERS)).toEqual(list);
  });

  it("matches q against title, company and location, case-insensitively", () => {
    const f = (q: string) => ids(filterApplications(list, { ...DEFAULT_APPLICATIONS_FILTERS, q }));
    expect(f("acme")).toEqual(["app1"]);
    expect(f("FRONTEND")).toEqual(["app2"]);
    expect(f("lyon")).toEqual(["app2"]);
    expect(f("engineer")).toEqual(["app1", "app3"]);
    expect(f("   ")).toEqual(["app1", "app2", "app3"]);
  });

  it("filters by Tracking status, folding the raw Application status into its bucket", () => {
    const f = (status: ApplicationsTableState["status"]) =>
      ids(filterApplications(list, { ...DEFAULT_APPLICATIONS_FILTERS, status }));
    expect(f(["IN_PROGRESS"])).toEqual(["app1"]);
    expect(f(["TO_APPLY"])).toEqual(["app3"]);
    expect(f(["REJECTED", "TO_APPLY"])).toEqual(["app2", "app3"]);
    expect(f(["ACCEPTED"])).toEqual([]);
  });

  it("filters by platform (multi-value) and by location substring", () => {
    expect(
      ids(filterApplications(list, { ...DEFAULT_APPLICATIONS_FILTERS, sourceSite: ["LINKEDIN", "WTTJ"] })),
    ).toEqual(["app2", "app3"]);
    expect(
      ids(filterApplications(list, { ...DEFAULT_APPLICATIONS_FILTERS, location: "par" })),
    ).toEqual(["app1"]);
  });

  it("filters by Scout, an exact match", () => {
    expect(
      ids(filterApplications(list, { ...DEFAULT_APPLICATIONS_FILTERS, scoutId: "s2" })),
    ).toEqual(["app3"]);
  });

  it("filters by the appliedAt range, inclusive of both whole days, excluding a never-applied row", () => {
    const f = (appliedAtFrom: string, appliedAtTo: string) =>
      ids(filterApplications(list, { ...DEFAULT_APPLICATIONS_FILTERS, appliedAtFrom, appliedAtTo }));
    expect(f("2026-08-01", "2026-08-01")).toEqual(["app1"]);
    expect(f("2026-08-02", "")).toEqual(["app2"]);
    expect(f("", "2026-08-05")).toEqual(["app1", "app2"]);
  });

  it("ANDs the filters together", () => {
    expect(
      ids(
        filterApplications(list, {
          ...DEFAULT_APPLICATIONS_FILTERS,
          q: "engineer",
          status: ["IN_PROGRESS", "TO_APPLY"],
          sourceSite: ["WTTJ"],
        }),
      ),
    ).toEqual(["app3"]);
  });

  it("treats a missing location or platform (not on every payload) as no value", () => {
    const bare = summary({
      id: "bare",
      jobOffer: { id: "j", title: "Ops", company: "Initech" },
    });
    expect(ids(filterApplications([bare], DEFAULT_APPLICATIONS_FILTERS))).toEqual(["bare"]);
    expect(
      ids(filterApplications([bare], { ...DEFAULT_APPLICATIONS_FILTERS, location: "paris" })),
    ).toEqual([]);
    expect(
      ids(filterApplications([bare], { ...DEFAULT_APPLICATIONS_FILTERS, sourceSite: ["LINKEDIN"] })),
    ).toEqual([]);
  });
});

describe("active filter counts", () => {
  it("counts only the advanced filters, one per filter rather than per value", () => {
    expect(activeAdvancedFilterCount(DEFAULT_APPLICATIONS_FILTERS)).toBe(0);
    expect(
      activeAdvancedFilterCount({ ...DEFAULT_APPLICATIONS_FILTERS, q: "x", status: ["REJECTED"] }),
    ).toBe(0);
    expect(
      activeAdvancedFilterCount({
        ...DEFAULT_APPLICATIONS_FILTERS,
        sourceSite: ["LINKEDIN", "WTTJ"],
        appliedAtFrom: "2026-08-01",
        appliedAtTo: "2026-08-31",
        scoutId: "s1",
        location: "Paris",
      }),
    ).toBe(5);
  });

  it("reports any filter at all as active, visible or folded away", () => {
    expect(hasActiveFilters(DEFAULT_APPLICATIONS_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_APPLICATIONS_FILTERS, q: "acme" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_APPLICATIONS_FILTERS, status: ["ACCEPTED"] })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_APPLICATIONS_FILTERS, scoutId: "s1" })).toBe(true);
  });
});

describe("sortApplications", () => {
  it("defaults to appliedAt descending", () => {
    expect(DEFAULT_APPLICATIONS_SORT).toEqual({ sortField: "appliedAt", sortDir: "desc" });
  });

  it("orders by appliedAt both ways, a never-applied row always last", () => {
    expect(ids(sortApplications(list, { sortField: "appliedAt", sortDir: "desc" }))).toEqual([
      "app2",
      "app1",
      "app3",
    ]);
    expect(ids(sortApplications(list, { sortField: "appliedAt", sortDir: "asc" }))).toEqual([
      "app1",
      "app2",
      "app3",
    ]);
  });

  it("does not mutate its input", () => {
    const copy = [...list];
    sortApplications(list, DEFAULT_APPLICATIONS_SORT);
    expect(list).toEqual(copy);
  });
});

describe("pagination", () => {
  const items = Array.from({ length: 30 }, (_, i) => i);

  it("slices one page at a time and counts the pages", () => {
    expect(paginate(items, { page: 1, pageSize: 25 })).toEqual(items.slice(0, 25));
    expect(paginate(items, { page: 2, pageSize: 25 })).toEqual(items.slice(25));
    expect(pageCount(items, { pageSize: 25 })).toBe(2);
    expect(pageCount([], { pageSize: 25 })).toBe(1);
  });

  it("exposes the same two page sizes as Analyses", () => {
    expect(APPLICATIONS_PAGE_SIZES).toEqual([25, 50]);
  });
});

describe("URL query-string state", () => {
  it("writes nothing for the default state, and reads an empty query back as the default", () => {
    expect(applicationsTableStateToParams(DEFAULT_APPLICATIONS_TABLE_STATE).toString()).toBe("");
    expect(parseApplicationsTableState(new URLSearchParams())).toEqual(
      DEFAULT_APPLICATIONS_TABLE_STATE,
    );
  });

  it("round-trips a fully-specified state through params and back", () => {
    const state: ApplicationsTableState = {
      q: "acme",
      status: ["IN_PROGRESS", "REJECTED"],
      appliedAtFrom: "2026-08-01",
      appliedAtTo: "2026-08-31",
      scoutId: "s1",
      sourceSite: ["LINKEDIN", "WTTJ"],
      location: "Paris",
      sortField: "appliedAt",
      sortDir: "asc",
      page: 3,
      pageSize: 50,
    };
    const params = applicationsTableStateToParams(state);
    expect(params.get("status")).toBe("IN_PROGRESS,REJECTED");
    expect(params.get("sourceSite")).toBe("LINKEDIN,WTTJ");
    expect(parseApplicationsTableState(params)).toEqual(state);
  });

  it("falls back to defaults for invalid values, keeping the multi-select values it got right", () => {
    const state = parseApplicationsTableState(
      new URLSearchParams(
        "status=REJECTED,APPLIED,REJECTED&sourceSite=MONSTER,INDEED&sortDir=sideways&page=-2&pageSize=7",
      ),
    );
    expect(state.status).toEqual(["REJECTED"]);
    expect(state.sourceSite).toEqual(["INDEED"]);
    expect(state.sortDir).toBe("desc");
    expect(state.page).toBe(1);
    expect(state.pageSize).toBe(25);
  });

  it("accepts exactly the 5 Tracking status buckets as the status param", () => {
    expect(
      parseApplicationsTableState(new URLSearchParams(`status=${TRACKING_STATUSES.join(",")},FAILED`))
        .status,
    ).toEqual([...TRACKING_STATUSES]);
  });
});
