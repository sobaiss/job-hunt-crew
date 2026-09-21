import { afterEach, beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { renderWithProviders, screen, waitFor, within } from "./test-utils";
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
  lastFour?: string | null;
};

function apiKey(source: "stored" | "environment" | "unresolved", lastFour: string | null = null): Parameter {
  return {
    name: "apiKey",
    secret: true,
    required: true,
    source,
    value: null,
    isSet: source !== "unresolved",
    lastFour: source === "stored" ? lastFour : null,
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
    updatedAt: null as string | null,
    settingId: null as string | null,
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

  describe("activation", () => {
    function withActiveOllama() {
      const active = settingsResponse({ activeProvider: "ollama" });
      active.providers[4].active = true;
      server.use(http.get("/api/admin/llm-provider-settings", () => HttpResponse.json(active)));
    }

    it("shows the active provider's radio selected and the None row's cleared", async () => {
      withActiveOllama();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      expect(within(screen.getAllByRole("row")[1]).getByRole("radio")).not.toBeChecked();
      expect(within(rowOf("Ollama")).getByRole("radio")).toBeChecked();
      expect(within(rowOf("OpenAI")).getByRole("radio")).not.toBeChecked();
    });

    it("activates a provider from its radio without opening the slide-over, then refreshes", async () => {
      let activated = 0;
      let listFetches = 0;
      server.use(
        http.get("/api/admin/llm-provider-settings", () => {
          listFetches += 1;
          return HttpResponse.json(settingsResponse());
        }),
        http.post("/api/admin/llm-provider-settings/ollama/activate", () => {
          activated += 1;
          return HttpResponse.json(settingsResponse({ activeProvider: "ollama" }));
        }),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      await user.click(within(rowOf("Ollama")).getByRole("radio"));

      await waitFor(() => expect(activated).toBe(1));
      await waitFor(() => expect(listFetches).toBeGreaterThan(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("activates a Dev-local provider without a confirmation step", async () => {
      let activated = false;
      server.use(
        http.post("/api/admin/llm-provider-settings/ollama/activate", () => {
          activated = true;
          return HttpResponse.json(settingsResponse({ activeProvider: "ollama" }));
        }),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      await user.click(within(rowOf("Ollama")).getByRole("radio"));

      await waitFor(() => expect(activated).toBe(true));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("returns control to the environment from the None row", async () => {
      withActiveOllama();
      let deactivated = 0;
      server.use(
        http.post("/api/admin/llm-provider-settings/deactivate", () => {
          deactivated += 1;
          return HttpResponse.json(settingsResponse());
        }),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      await user.click(within(screen.getAllByRole("row")[1]).getByRole("radio"));

      await waitFor(() => expect(deactivated).toBe(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows the API's message inline when an activation is refused, and refreshes the table", async () => {
      let listFetches = 0;
      server.use(
        http.get("/api/admin/llm-provider-settings", () => {
          listFetches += 1;
          return HttpResponse.json(settingsResponse());
        }),
        http.post("/api/admin/llm-provider-settings/anthropic/activate", () =>
          HttpResponse.json(
            {
              detail:
                "Cannot activate Anthropic: required parameter(s) apiKey resolve nowhere",
            },
            { status: 422 },
          ),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      await user.click(within(rowOf("Anthropic")).getByRole("radio"));

      expect(await screen.findByRole("alert")).toHaveTextContent("apiKey resolve nowhere");
      await waitFor(() => expect(listFetches).toBeGreaterThan(1));
      expect(within(rowOf("Anthropic")).getByRole("radio")).not.toBeChecked();
      expect(within(screen.getAllByRole("row")[1]).getByRole("radio")).toBeChecked();
    });

    it("falls back to a generic message when the refusal carries none", async () => {
      server.use(
        http.post("/api/admin/llm-provider-settings/ollama/activate", () =>
          HttpResponse.json({ error: "Upstream service unavailable" }, { status: 502 }),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      await user.click(within(rowOf("Ollama")).getByRole("radio"));

      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't change the active provider");
    });

    it("clears an earlier refusal once a later change succeeds", async () => {
      server.use(
        http.post("/api/admin/llm-provider-settings/anthropic/activate", () =>
          HttpResponse.json({ detail: "Cannot activate Anthropic" }, { status: 422 }),
        ),
        http.post("/api/admin/llm-provider-settings/ollama/activate", () =>
          HttpResponse.json(settingsResponse({ activeProvider: "ollama" })),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");
      await user.click(within(rowOf("Anthropic")).getByRole("radio"));
      await screen.findByRole("alert");

      await user.click(within(rowOf("Ollama")).getByRole("radio"));

      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });
  });

  describe("slide-over", () => {
    function withStoredOllama() {
      const stored = settingsResponse();
      const ollama = stored.providers[4];
      ollama.configuration = "configured";
      ollama.settingId = "setting-ollama";
      ollama.updatedAt = "2026-09-20T10:00:00";
      ollama.parameters = [
        {
          name: "baseUrl",
          secret: false,
          required: false,
          source: "default",
          value: "http://localhost:11434/v1",
          isSet: true,
        },
        {
          name: "model",
          secret: false,
          required: false,
          source: "stored",
          value: "qwen3:8b",
          isSet: true,
        },
      ];
      server.use(http.get("/api/admin/llm-provider-settings", () => HttpResponse.json(stored)));
    }

    function withStoredOpenAiKey(lastFour: string | null) {
      const stored = settingsResponse();
      const openai = stored.providers[1];
      openai.configuration = "configured";
      openai.settingId = "setting-openai";
      openai.parameters = [apiKey("stored", lastFour), model("gpt-4o")];
      server.use(http.get("/api/admin/llm-provider-settings", () => HttpResponse.json(stored)));
    }

    // The body of the next save to `providerKey`, read after it was submitted.
    function captureSave(providerKey: string): () => unknown {
      let body: unknown;
      server.use(
        http.put(`/api/admin/llm-provider-settings/${providerKey}`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(settingsResponse().providers[1]);
        }),
      );
      return () => body;
    }

    async function openSlideOver(name: string) {
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText(name);
      await user.click(within(rowOf(name)).getByText(name));
      const dialog = await screen.findByRole("dialog");
      return { user, dialog };
    }

    it("opens on a provider row and shows only that provider's parameters", async () => {
      const { dialog } = await openSlideOver("Ollama");

      expect(within(dialog).getByText("Ollama")).toBeInTheDocument();
      expect(within(dialog).getByText("Dev-local")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Base URL")).toBeInTheDocument();
      expect(within(dialog).getByLabelText("Model")).toBeInTheDocument();
      expect(within(dialog).queryByText("API key")).not.toBeInTheDocument();
    });

    it("shows the active state read-only, with no activation control", async () => {
      const { dialog } = await openSlideOver("Ollama");

      expect(within(dialog).getByText("Not active")).toBeInTheDocument();
      expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    });

    it("does not open from the None row or from a radio", async () => {
      server.use(
        http.post("/api/admin/llm-provider-settings/ollama/activate", () =>
          HttpResponse.json(settingsResponse({ activeProvider: "ollama" })),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<AdminLlmProvidersPage />);
      await screen.findByText("Anthropic");

      await user.click(screen.getByText("None — follow the environment"));
      await user.click(within(rowOf("Ollama")).getByRole("radio"));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("pre-fills a stored value and shows inherited and default values as placeholders", async () => {
      withStoredOllama();
      const { dialog } = await openSlideOver("Ollama");

      const model = within(dialog).getByLabelText("Model");
      expect(model).toHaveValue("qwen3:8b");
      const baseUrl = within(dialog).getByLabelText("Base URL");
      expect(baseUrl).toHaveValue("");
      expect(baseUrl).toHaveAttribute("placeholder", "http://localhost:11434/v1");
      expect(within(dialog).getByText("Stored")).toBeInTheDocument();
      expect(within(dialog).getByText("Provider default")).toBeInTheDocument();
    });

    it("shows a secret as an empty password input, never its value", async () => {
      const { dialog } = await openSlideOver("OpenAI");

      const input = within(dialog).getByLabelText("API key");
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveValue("");
    });

    it("uses the last four of a stored secret as the placeholder", async () => {
      withStoredOpenAiKey("WXYZ");
      const { dialog } = await openSlideOver("OpenAI");

      expect(within(dialog).getByLabelText("API key")).toHaveAttribute(
        "placeholder",
        "Stored — ending in WXYZ",
      );
      expect(within(dialog).getByText("Stored")).toBeInTheDocument();
    });

    it("shows a stored secret too short for a hint as stored, with no digits", async () => {
      withStoredOpenAiKey(null);
      const { dialog } = await openSlideOver("OpenAI");

      expect(within(dialog).getByLabelText("API key")).toHaveAttribute("placeholder", "Stored");
    });

    it("says a secret supplied by the environment is set via the environment", async () => {
      const { dialog } = await openSlideOver("OpenAI");

      expect(within(dialog).getByLabelText("API key")).toHaveAttribute(
        "placeholder",
        "Set via the environment",
      );
      expect(within(dialog).getByText("From the environment")).toBeInTheDocument();
    });

    it("says a secret that resolves nowhere is not set", async () => {
      const { dialog } = await openSlideOver("Anthropic");

      expect(within(dialog).getByLabelText("API key")).toHaveAttribute("placeholder", "Not set");
    });

    it("offers no Clear while the value is only inherited", async () => {
      const { dialog } = await openSlideOver("OpenAI");

      expect(within(dialog).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    });

    it("offers Clear once a value is stored", async () => {
      withStoredOpenAiKey("WXYZ");
      const { dialog } = await openSlideOver("OpenAI");

      expect(within(dialog).getByRole("button", { name: "Clear" })).toBeInTheDocument();
    });

    it("submits a typed secret with the fields that changed, and only those", async () => {
      const body = captureSave("openai");
      const { user, dialog } = await openSlideOver("OpenAI");

      await user.type(within(dialog).getByLabelText("API key"), "sk-proj-typed-key");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body()).toEqual({ parameters: { apiKey: "sk-proj-typed-key" } }));
    });

    it("leaves a blank secret out of the body so the stored key is kept", async () => {
      withStoredOpenAiKey("WXYZ");
      const body = captureSave("openai");
      const { user, dialog } = await openSlideOver("OpenAI");

      await user.type(within(dialog).getByLabelText("Model"), "gpt-4.1");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body()).toEqual({ parameters: { model: "gpt-4.1" } }));
    });

    it("submits null for a secret when Clear was chosen", async () => {
      withStoredOpenAiKey("WXYZ");
      const body = captureSave("openai");
      const { user, dialog } = await openSlideOver("OpenAI");

      await user.click(within(dialog).getByRole("button", { name: "Clear" }));
      expect(within(dialog).getByText("Will be cleared when you save")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body()).toEqual({ parameters: { apiKey: null } }));
    });

    it("lets a pending Clear be undone before saving", async () => {
      withStoredOpenAiKey("WXYZ");
      const body = captureSave("openai");
      const { user, dialog } = await openSlideOver("OpenAI");

      await user.click(within(dialog).getByRole("button", { name: "Clear" }));
      await user.click(within(dialog).getByRole("button", { name: "Keep" }));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body()).toEqual({ parameters: {} }));
    });

    it("clears rather than replaces when text was typed and Clear was then chosen", async () => {
      withStoredOpenAiKey("WXYZ");
      const body = captureSave("openai");
      const { user, dialog } = await openSlideOver("OpenAI");

      await user.type(within(dialog).getByLabelText("API key"), "sk-typed");
      await user.click(within(dialog).getByRole("button", { name: "Clear" }));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body()).toEqual({ parameters: { apiKey: null } }));
    });

    it("shows an error alert and stays open when the encryption key is missing", async () => {
      server.use(
        http.put("/api/admin/llm-provider-settings/openai", () =>
          HttpResponse.json(
            { detail: "SETTINGS_ENCRYPTION_KEY is not set; a secret cannot be encrypted" },
            { status: 500 },
          ),
        ),
      );
      const { user, dialog } = await openSlideOver("OpenAI");

      await user.type(within(dialog).getByLabelText("API key"), "sk-proj-typed-key");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("SETTINGS_ENCRYPTION_KEY");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("submits only the changed fields, then closes and refreshes the list", async () => {
      withStoredOllama();
      let body: unknown;
      let listFetches = 0;
      server.use(
        http.get("/api/admin/llm-provider-settings", () => {
          listFetches += 1;
          return HttpResponse.json(settingsResponse());
        }),
        http.put("/api/admin/llm-provider-settings/ollama", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(settingsResponse().providers[4]);
        }),
      );
      const { user, dialog } = await openSlideOver("Ollama");

      await user.type(within(dialog).getByLabelText("Base URL"), "http://gpu-box:11434/v1");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(body).toEqual({ parameters: { baseUrl: "http://gpu-box:11434/v1" } });
      await waitFor(() => expect(listFetches).toBeGreaterThan(1));
    });

    it("submits an emptied stored field as blank so the API removes it", async () => {
      withStoredOllama();
      let body: unknown;
      server.use(
        http.put("/api/admin/llm-provider-settings/ollama", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(settingsResponse().providers[4]);
        }),
      );
      const { user, dialog } = await openSlideOver("Ollama");

      await user.clear(within(dialog).getByLabelText("Model"));
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body).toEqual({ parameters: { model: "" } }));
    });

    it("stores nothing when saved untouched", async () => {
      let body: unknown;
      server.use(
        http.put("/api/admin/llm-provider-settings/ollama", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(settingsResponse().providers[4]);
        }),
      );
      const { user, dialog } = await openSlideOver("Ollama");

      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(body).toEqual({ parameters: {} }));
    });

    it("keeps the slide-over open with the API's message when saving fails", async () => {
      server.use(
        http.put("/api/admin/llm-provider-settings/ollama", () =>
          HttpResponse.json({ detail: "baseUrl must be an absolute http(s) URL" }, { status: 422 }),
        ),
      );
      const { user, dialog } = await openSlideOver("Ollama");

      await user.type(within(dialog).getByLabelText("Base URL"), "gpu-box");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "baseUrl must be an absolute http(s) URL",
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("falls back to a generic message when the failure carries none", async () => {
      server.use(
        http.put("/api/admin/llm-provider-settings/ollama", () =>
          HttpResponse.json({ error: "Upstream service unavailable" }, { status: 502 }),
        ),
      );
      const { user, dialog } = await openSlideOver("Ollama");

      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't save");
    });
  });
});
