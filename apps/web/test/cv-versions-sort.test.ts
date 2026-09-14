import { describe, expect, it } from "vitest";

import {
  DEFAULT_CV_VERSIONS_SORT,
  sortCvVersions,
} from "@/lib/cv-versions-sort";
import type { CvVersion } from "@/hooks/use-cv-versions";

function cv(overrides: Partial<CvVersion> = {}): CvVersion {
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

describe("sortCvVersions", () => {
  it("sorts the label column ascending/descending by localeCompare", () => {
    const list = [
      cv({ id: "b", label: "Beta CV" }),
      cv({ id: "a", label: "Alpha CV" }),
    ];

    expect(
      sortCvVersions(list, { column: "label", direction: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      sortCvVersions(list, { column: "label", direction: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["b", "a"]);
  });

  it("sorts the file column by fileName", () => {
    const list = [
      cv({ id: "z", fileName: "z.pdf" }),
      cv({ id: "a", fileName: "a.pdf" }),
    ];

    expect(
      sortCvVersions(list, { column: "file", direction: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["a", "z"]);
  });

  it("sorts the size column numerically", () => {
    const list = [
      cv({ id: "big", fileSizeBytes: 900_000 }),
      cv({ id: "small", fileSizeBytes: 1_000 }),
    ];

    expect(
      sortCvVersions(list, { column: "size", direction: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["small", "big"]);
    expect(
      sortCvVersions(list, { column: "size", direction: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["big", "small"]);
  });

  it("sorts the uploaded column as ISO-8601 strings, newest first by default", () => {
    const list = [
      cv({ id: "earlier", createdAt: "2026-07-01T00:00:00.000Z" }),
      cv({ id: "later", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];

    expect(
      sortCvVersions(list, DEFAULT_CV_VERSIONS_SORT).map((c) => c.id),
    ).toEqual(["later", "earlier"]);
  });

  it("sorts the status column by conversionStatus", () => {
    const list = [
      cv({ id: "converted", conversionStatus: "CONVERTED" }),
      cv({ id: "failed", conversionStatus: "FAILED" }),
      cv({ id: "pending", conversionStatus: "PENDING" }),
    ];

    expect(
      sortCvVersions(list, { column: "status", direction: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["converted", "failed", "pending"]);
  });

  it("sorts the default column with default rows first descending", () => {
    const list = [
      cv({ id: "regular", isDefault: false }),
      cv({ id: "default", isDefault: true }),
    ];

    expect(
      sortCvVersions(list, { column: "default", direction: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["default", "regular"]);
    expect(
      sortCvVersions(list, { column: "default", direction: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["regular", "default"]);
  });
});
