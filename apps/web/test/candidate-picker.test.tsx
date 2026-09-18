import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { renderWithProviders, screen } from "./test-utils";
import { server } from "./msw/server";
import { CandidatePicker } from "@/components/candidate-picker";

function usersListResponse(overrides: Record<string, unknown> = {}) {
  return {
    users: [
      {
        id: "user-1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        plan: "FREE",
        role: "EXTERNAL",
        blocked: false,
        atOrOverLimit: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
    ...overrides,
  };
}

// Issue #160: extracted from the Admin users table's name/email search so the
// three upcoming admin tables (#161/#162/#163) can each offer "filter by
// candidate" without reimplementing user search.
describe("CandidatePicker", () => {
  it("behaves as a plain labelled search input when no onSelectCandidate is given", async () => {
    function Harness() {
      const [value, setValue] = useState("");
      return <CandidatePicker id="picker" label="Search" value={value} onChange={setValue} />;
    }

    // No handler registered for /api/admin/users — msw's onUnhandledRequest:
    // "error" setup means any request here would fail the test, proving this
    // mode never queries the search endpoint.
    renderWithProviders(<Harness />);
    await userEvent.type(screen.getByLabelText("Search"), "ada");

    expect(screen.getByLabelText("Search")).toHaveValue("ada");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows matching candidates and resolves a selection to one userId", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/admin/users", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(usersListResponse());
      }),
    );

    const selected: unknown[] = [];

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <CandidatePicker
          id="picker"
          label="Candidate"
          value={value}
          onChange={setValue}
          onSelectCandidate={(candidate) => selected.push(candidate)}
        />
      );
    }

    renderWithProviders(<Harness />);

    const input = screen.getByLabelText("Candidate");
    await userEvent.type(input, "ada");

    expect(await screen.findByRole("option", { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(capturedUrl).toContain("search=ada");

    await userEvent.click(screen.getByRole("option", { name: /Ada Lovelace/ }));

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      id: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows a no-matches state when the search returns nothing", async () => {
    server.use(
      http.get("/api/admin/users", () => HttpResponse.json(usersListResponse({ users: [], total: 0 }))),
    );

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <CandidatePicker
          id="picker"
          label="Candidate"
          value={value}
          onChange={setValue}
          onSelectCandidate={() => {}}
        />
      );
    }

    renderWithProviders(<Harness />);
    await userEvent.type(screen.getByLabelText("Candidate"), "zzz");

    expect(await screen.findByText("No matching candidates.")).toBeInTheDocument();
  });
});
