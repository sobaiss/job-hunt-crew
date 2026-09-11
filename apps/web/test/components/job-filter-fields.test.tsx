import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen } from "../test-utils";
import {
  JobFilterFields,
  EMPTY_JOB_FILTERS,
  jobFiltersFrom,
  toFilterPayload,
  type JobFilterValues,
} from "@/components/job-filter-fields";

function Harness({ onChange }: { onChange?: (v: JobFilterValues) => void }) {
  const [values, setValues] = useState<JobFilterValues>(EMPTY_JOB_FILTERS);
  return (
    <JobFilterFields
      idPrefix="test"
      values={values}
      onChange={(next) => {
        setValues(next);
        onChange?.(next);
      }}
    />
  );
}

describe("JobFilterFields", () => {
  it("renders the six job-search filter fields", async () => {
    renderWithProviders(<Harness />);

    expect(await screen.findByLabelText("Keywords")).toBeInTheDocument();
    expect(screen.getByLabelText("Location")).toBeInTheDocument();
    expect(screen.getByLabelText("Posted within")).toBeInTheDocument();
    expect(screen.getByLabelText("Contract type")).toBeInTheDocument();
    expect(screen.getByLabelText("Remote policy")).toBeInTheDocument();
    expect(screen.getByLabelText("Experience level")).toBeInTheDocument();
  });

  it("reports every edit back through onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onChange={onChange} />);

    await user.type(await screen.findByLabelText("Keywords"), "python");
    await user.selectOptions(screen.getByLabelText("Posted within"), "7d");
    await user.selectOptions(screen.getByLabelText("Remote policy"), "remote");

    const last = onChange.mock.calls.at(-1)?.[0] as JobFilterValues;
    expect(last.keywords).toBe("python");
    expect(last.postedWithin).toBe("7d");
    expect(last.remote).toBe("remote");
  });
});

describe("toFilterPayload", () => {
  it("trims free-text fields and drops the blank ones", () => {
    expect(
      toFilterPayload({
        ...EMPTY_JOB_FILTERS,
        keywords: "  backend  ",
        location: "   ",
        postedWithin: "7d",
        remote: "remote",
      }),
    ).toEqual({ keywords: "backend", postedWithin: "7d", remote: "remote" });
  });

  it("always sends postedWithin, even when it is 'any'", () => {
    expect(toFilterPayload(EMPTY_JOB_FILTERS)).toEqual({ postedWithin: "any" });
  });
});

describe("jobFiltersFrom", () => {
  it("seeds from a stored Scout's nullable filters, falling back for the rest", () => {
    expect(
      jobFiltersFrom(
        {
          keywords: "python",
          location: null,
          postedWithin: "7d",
          contractType: null,
          remote: null,
          experienceLevel: null,
        },
        { ...EMPTY_JOB_FILTERS, postedWithin: "7d" },
      ),
    ).toEqual({
      keywords: "python",
      location: "",
      postedWithin: "7d",
      contractType: "",
      remote: "",
      experienceLevel: "",
    });
  });
});
