"""RecommendationWriterAgent (PRD Section 10 step 6, M2-T6).

Takes the ComparisonAnalysisAgent's output (M2-T6) plus the underlying
JobOffer/CVVersion structured data and produces the improvement_suggestions
and summary portion of the Section 8.6 Analysis result schema. Built on top
of the LLM provider abstraction (analysis.llm_provider), mirroring
comparison_analysis_agent's design.
"""

import json
from typing import Literal

from pydantic import BaseModel, ValidationError

from .comparison_analysis_agent import ComparisonResult
from .llm_provider import LLMProvider, get_llm_provider

MAX_ATTEMPTS = 3

SYSTEM_PROMPT = (
    "You write prioritized improvement suggestions and a summary for a candidate, "
    "given a JSON comparison of their CV against a job offer (matched/missing skills, "
    "strengths, weaknesses, match_score). "
    "Respond with ONLY a single JSON object, no markdown fences, no commentary, "
    "matching this shape: "
    '{"improvement_suggestions": [{"area": string, "suggestion": string, '
    '"priority": "high"|"medium"|"low"}], "summary": string}.'
)


class ImprovementSuggestion(BaseModel):
    area: str
    suggestion: str
    priority: Literal["high", "medium", "low"]


class RecommendationResult(BaseModel):
    improvement_suggestions: list[ImprovementSuggestion]
    summary: str


class RecommendationWriterError(Exception):
    pass


def _parse_llm_output(raw: str) -> RecommendationResult:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json") :]
    data = json.loads(text)
    return RecommendationResult.model_validate(data)


def run_recommendation_writer(
    comparison_result: ComparisonResult,
    *,
    llm_provider: LLMProvider | None = None,
) -> RecommendationResult:
    """Runs the RecommendationWriterAgent against the given comparison result,
    retrying up to MAX_ATTEMPTS on malformed LLM output. Raises
    RecommendationWriterError if every attempt fails.
    """
    provider = llm_provider or get_llm_provider()
    prompt = comparison_result.model_dump_json()

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(system=SYSTEM_PROMPT, prompt=prompt)
            return _parse_llm_output(raw)
        except (json.JSONDecodeError, ValidationError, TypeError) as exc:
            last_error = exc
            continue

    raise RecommendationWriterError(
        f"RecommendationWriterAgent failed after {MAX_ATTEMPTS} attempts: {last_error}"
    )
