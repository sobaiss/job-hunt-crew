"""Code-owned catalogue of the LLM providers the system implements and the
parameters each one needs (issue #173, docs/adr/0024).

Declares, once, for each provider: display name, maturity, and its Provider
parameters — logical name (`apiKey`, `baseUrl`, `model`), whether it is
secret, whether it is required, its environment-variable fallback and its
hardcoded default. It is the single source of those defaults: the provider
clients in `analysis.llm_provider` read them from here rather than keeping a
second copy, and the API reads the same declaration to render the Admin
screen.

A parameter is *required* exactly when it has no hardcoded default. `model`
declares no environment fallback on purpose: `LLM_MODEL` governs only the
environment-driven factory (docs/adr/0024). The fixed openrouter/huggingface
base URLs are transport details, not Provider parameters, and stay in the
provider clients.

Hand-written (not sqlacodegen output), like `quotas.py`. Deliberately not a
table: every parameter name is wired into a provider constructor, so one no
code reads would be a row that does nothing.
"""

from dataclasses import dataclass
from enum import StrEnum


class Maturity(StrEnum):
    PRODUCTION = "production"
    OPT_IN = "opt-in"
    DEV_LOCAL = "dev-local"


@dataclass(frozen=True)
class ProviderParameter:
    name: str
    secret: bool = False
    env_var: str | None = None
    default: str | None = None

    @property
    def required(self) -> bool:
        return self.default is None


@dataclass(frozen=True)
class ProviderSpec:
    key: str
    display_name: str
    maturity: Maturity
    parameters: tuple[ProviderParameter, ...]

    def parameter(self, name: str) -> ProviderParameter:
        for parameter in self.parameters:
            if parameter.name == name:
                return parameter
        raise KeyError(f"LLM provider {self.key!r} has no parameter {name!r}")


# Catalogue order is the order the Admin screen lists providers in.
LLM_PROVIDERS: tuple[ProviderSpec, ...] = (
    ProviderSpec(
        key="anthropic",
        display_name="Anthropic",
        maturity=Maturity.PRODUCTION,
        parameters=(
            ProviderParameter("apiKey", secret=True, env_var="ANTHROPIC_API_KEY"),
            ProviderParameter("model", default="claude-sonnet-4-5"),
        ),
    ),
    ProviderSpec(
        key="openai",
        display_name="OpenAI",
        maturity=Maturity.PRODUCTION,
        parameters=(
            ProviderParameter("apiKey", secret=True, env_var="OPENAI_API_KEY"),
            ProviderParameter("model", default="gpt-4o"),
        ),
    ),
    ProviderSpec(
        key="openrouter",
        display_name="OpenRouter",
        maturity=Maturity.OPT_IN,
        parameters=(
            ProviderParameter("apiKey", secret=True, env_var="OPENROUTER_API_KEY"),
            ProviderParameter("model", default="anthropic/claude-sonnet-4-5"),
        ),
    ),
    ProviderSpec(
        key="huggingface",
        display_name="Hugging Face",
        maturity=Maturity.OPT_IN,
        parameters=(
            ProviderParameter("apiKey", secret=True, env_var="HF_TOKEN"),
            ProviderParameter("model", default="meta-llama/Llama-3.3-70B-Instruct"),
        ),
    ),
    ProviderSpec(
        key="ollama",
        display_name="Ollama",
        maturity=Maturity.DEV_LOCAL,
        parameters=(
            ProviderParameter(
                "baseUrl",
                env_var="OLLAMA_BASE_URL",
                default="http://localhost:11434/v1",
            ),
            ProviderParameter("model", default="qwen3.5:latest"),
        ),
    ),
)


def get_provider_spec(key: str) -> ProviderSpec:
    for spec in LLM_PROVIDERS:
        if spec.key == key:
            return spec
    raise KeyError(f"Unknown LLM provider {key!r}")
