import { afterEach, beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, within } from "./test-utils";
import { server } from "./msw/server";
import { __setUrl } from "./next-navigation-mock";
import AdminLlmProvidersPage from "@/app/(app)/admin/llm-providers/page";

type Parameter = {
  name: string;
  secret: boolean;
  required: boolean;
  source: string;
  value: string | null;
  isSet: boolean;
};

function apiKey(source: "environment" | "unresolved"): Parameter {
  return {
    name: "apiKey",
    secret: true,
    required: true,
    source,
    value: null,
    isSet: source === "environment",
  };
}

function model(value: string): Parameter {
  return { name: "model", secret: false, required: false, source: "default", value, isSet: true };
}

function provider(
  key: string,
  displayName: string,
  maturity: string,
  configuration: string,
  parameters: Parameter[],
) {
  return {
    key,
    displayName,
    maturity,
    active: false,
    configuration,
    updatedAt: null,
    settingId: null,
    parameters,
  };
}

function settingsResponse(overrides: Record<string, unknown> = {}) {
  return {
    activeProvider: null,
    environmentProvider: { key: "ollama", unsupportedValue: null },
    providers: [
      provider("anthropic", "Anthropic", "production", "incomplete", [
        apiKey("unresolved"),
        model("claude-sonnet-4-5"),
      ]),
      provider("openai", "OpenAI", "production", "inherited", [
        apiKey("environment"),
        model("gpt-4o"),
      ]),
      provider("openrouter", "OpenRouter", "opt-in", "incomplete", [
        apiKey("unresolved"),
        model("anthropic/claude-sonnet-4-5"),
      ]),
      provider("huggingface", "Hugging Face", "opt-in", "incomplete", [
        apiKey("unresolved"),
        model("meta-llama/Llama-3.3-70B-Instruct"),
      ]),
      provider("ollama", "Ollama", "dev-local", "inherited", [
        {
          name: "baseUrl",
          secret: false,
          required: false,
          source: "default",
          value: "http://localhost:11434/v1",
          isSet: true,
        },
        model("qwen3.5:latest"),
      ]),
    ],
    ...overrides,
  };
}

// The provider's own row, found by its Provider cell -- the None row also
// names a provider ("Currently: Ollama"), so a text match on the row alone
// would be ambiguous.
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[1]?.textContent === name);
  if (!row) throw new Error(`No row for provider ${name}`);
  return row;
}

describe("AdminLlmProvidersPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __setUrl("/admin/llm-providers");
    server.use(
      http.get("/api/admin/llm-provider-settings", () => HttpResponse.json(settingsResponse())),
    );
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("lists the five providers in catalogue order with a Maturity badge each", async () => {
    renderWithProviders(<AdminLlmProvidersPage />);

    const rows = await screen.findAllByRole("row");
    // header + the None row + five providers
    expect(rows).toHaveLength(7);
    const providerRows = rows.slice(2);
    expect(providerRows.map((row) => within(row).getAllByRole("cell")[1].textContent)).toEqual([
      "Anthropic",
      "OpenAI",
      "OpenRouter",
      "Hugging Face",
      "Ollama",
    ]);
    expect(within(rowOf("Anthropic")).getByText("Production")).toBeInTheDocument();
    expect(within(rowOf("OpenRouter")).getByText("Opt-in")).toBeInTheDocument();
    expect(within(rowOf("Ollama")).getByText("Dev-local")).toBeInTheDocument();
  });

  it("reads Incomplete when a required key resolves nowhere and Inherited otherwise", async () => {
    renderWithProviders(<AdminLlmProvidersPage />);
    await screen.findByText("Anthropic");

    expect(within(rowOf("Anthropic")).getByText("Incomplete")).toBeInTheDocument();
    expect(within(rowOf("OpenAI")).getByText("Inherited")).toBeInTheDocument();
    expect(within(rowOf("Ollama")).getByText("Inherited")).toBeInTheDocument();
  });

  it("marks the secret required parameters, and shows none for a provider without any", async () => {
    renderWithProviders(<AdminLlmProvidersPage />);
    await screen.findByText("Anthropic");

    const anthropic = within(rowOf("Anthropic"));
    expect(anthropic.getByText("apiKey")).toBeInTheDocument();
    expect(anthropic.getByLabelText("Secret")).toBeInTheDocument();
    expect(anthropic.queryByText("model")).not.toBeInTheDocument();
    expect(within(rowOf("Ollama")).queryByLabelText("Secret")).not.toBeInTheDocument();
  });

  it("leads with a selected None row naming the provider the environment resolves to", async () => {
    renderWithProviders(<AdminLlmProvidersPage />);
    await screen.findByText("Anthropic");

    const none = screen.getAllByRole("row")[1];
    expect(within(none).getByText("None — follow the environment")).toBeInTheDocument();
    expect(within(none).getByText("Currently: Ollama")).toBeInTheDocument();
    expect(within(none).getByRole("radio")).toBeChecked();
    for (const name of ["Anthropic", "OpenAI", "OpenRouter", "Hugging Face", "Ollama"]) {
      expect(within(rowOf(name)).getByRole("radio")).not.toBeChecked();
    }
  });

  it("warns instead of breaking when LLM_PROVIDER holds an unsupported value", async () => {
    server.use(
      http.get("/api/admin/llm-provider-settings", () =>
        HttpResponse.json(
          settingsResponse({ environmentProvider: { key: null, unsupportedValue: "gemini" } }),
        ),
      ),
    );
    renderWithProviders(<AdminLlmProvidersPage />);

    expect(await screen.findByText(/unsupported/i)).toHaveTextContent("gemini");
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("hides the id column by default, and keeps Active and Provider out of the Columns menu", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminLlmProvidersPage />);
    await screen.findByText("Anthropic");

    expect(screen.queryByRole("columnheader", { name: "ID" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "ID" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.queryByRole("menuitemcheckbox", { name: "Active" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Provider" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: "ID" }));
    await user.keyboard("{Escape}");

    expect(screen.getByRole("columnheader", { name: "ID" })).toBeInTheDocument();
  });

  it("persists column choices under its own storage key", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminLlmProvidersPage />);
    await screen.findByText("Anthropic");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Maturity" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("columnheader", { name: "Maturity" })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("column-visibility:admin-llm-providers")!)).toMatchObject({
      maturity: false,
      id: false,
    });
  });

  it("shows an error when the list can't be loaded", async () => {
    server.use(
      http.get("/api/admin/llm-provider-settings", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderWithProviders(<AdminLlmProvidersPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load");
  });
});
