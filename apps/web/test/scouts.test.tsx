import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
import { server } from "./msw/server";
import ScoutsPage from "@/app/(app)/scouts/page";
import NewScoutPage from "@/app/(app)/scouts/new/page";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ id: "scout-1" }),
}));

beforeEach(() => {
  push.mockReset();
});

function cv(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv-default",
    label: "Default CV",
    fileName: "cv.pdf",
    fileType: "PDF",
    fileSizeBytes: 1234,
    isDefault: true,
    conversionStatus: "CONVERTED",
    conversionError: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function scout(overrides: Record<string, unknown> = {}) {
  return {
    id: "scout-1",
    userId: "user_1",
    label: "Senior Backend — Remote EU",
    cvVersionId: "cv-default",
    targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN"],
    filters: {
      keywords: "python",
      location: null,
      postedWithin: "7d",
      contractType: null,
      remote: null,
      experienceLevel: null,
    },
    matchThreshold: 70,
    status: "ACTIVE",
    lastRunAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScoutsPage — list", () => {
  it("lists each Scout with its status and base CV and a New Scout link", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [scout()] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(
      await screen.findByRole("link", { name: "Senior Backend — Remote EU" }),
    ).toHaveAttribute("href", "/scouts/scout-1");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Default CV/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New Scout" })).toHaveAttribute(
      "href",
      "/scouts/new",
    );
  });

  it("shows an empty state when there are no Scouts", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ scouts: [] })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(
      await screen.findByText("You don't have any Scouts yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    server.use(
      http.get("/api/scouts", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [] }),
      ),
    );

    renderWithProviders(<ScoutsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't load your Scouts.",
    );
  });
});

describe("NewScoutPage — create form", () => {
  it("pre-checks France Travail and defaults the threshold to 70", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );

    renderWithProviders(<NewScoutPage />);

    const franceTravail = await screen.findByRole("checkbox", {
      name: "France Travail",
    });
    expect(franceTravail).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "LinkedIn" })).not.toBeChecked();
    expect(screen.getByLabelText("Relevance threshold")).toHaveValue(70);
  });

  it("validates an empty label and at least one site", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.click(await screen.findByRole("checkbox", { name: "France Travail" }));
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    expect(
      await screen.findByText("Give this Scout a label."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose at least one job site."),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("submits the configured Scout and redirects to the list", async () => {
    const received: unknown[] = [];
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ scout: scout() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(
      await screen.findByLabelText("Label"),
      "Senior Backend — Remote EU",
    );
    await user.click(screen.getByRole("checkbox", { name: "LinkedIn" }));
    await user.type(screen.getByLabelText("Keywords"), "python");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/scouts"));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      label: "Senior Backend — Remote EU",
      cvVersionId: "cv-default",
      targetSiteKeys: ["FRANCE_TRAVAIL", "LINKEDIN"],
      matchThreshold: 70,
      filters: { keywords: "python", postedWithin: "7d" },
    });
  });

  it("submits the shared job-search filters (contract type, remote, experience level)", async () => {
    const received: unknown[] = [];
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json({ scout: scout() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(await screen.findByLabelText("Label"), "Filtered Scout");
    await user.type(screen.getByLabelText("Contract type"), "CDI");
    await user.selectOptions(screen.getByLabelText("Remote policy"), "remote");
    await user.type(screen.getByLabelText("Experience level"), "senior");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      filters: {
        contractType: "CDI",
        remote: "remote",
        experienceLevel: "senior",
        postedWithin: "7d",
      },
    });
  });

  it("shows an error when the server rejects the create (e.g. Scout cap)", async () => {
    server.use(
      http.get("/api/cv-versions", () =>
        HttpResponse.json({ cvVersions: [cv()] }),
      ),
      http.post("/api/scouts", () =>
        HttpResponse.json(
          { error: "You can have at most 5 active Scouts." },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewScoutPage />);

    await user.type(await screen.findByLabelText("Label"), "Sixth Scout");
    await user.click(screen.getByRole("button", { name: "Create Scout" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't save that Scout.");
    expect(push).not.toHaveBeenCalled();
  });
});
